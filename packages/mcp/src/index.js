import {
  parse,
  validate,
  validateSchema,
  execute,
  getNamedType,
  astFromValue,
  print,
  valueFromASTUntyped,
  coerceInputValue,
  GraphQLNonNull,
  GraphQLList,
  GraphQLScalarType,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLObjectType,
  isSpecifiedScalarType,
} from 'graphql';
import { SimfinityError } from '@simtlix/simfinity-core';
import { virtualFieldOptions } from '@simtlix/simfinity-core/internal/relation-storage';

const FILTER_OPERATORS_TEXT = 'EQ, NE, LT, LTE, GT, GTE, IN, NIN, BTW, LIKE';

/** Allowed shape for published MCP tool names (SEP-986). */
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Curated fallback documentation for the synthetic filter / pagination / sort /
 * aggregation types and arguments that Simfinity generates (see
 * `createArgsForQuery` in src/index.js). These types carry no GraphQL
 * `description`, so this map supplies one only when none is present. Keys are
 * either a type name (`QLFilter`) or a `TypeName.fieldName` pair.
 */
const SIMFINITY_FILTER_DOCS = Object.assign(Object.create(null), {
  QLOperator: 'Comparison operator: EQ (equals), NE (not equals), LT, LTE, GT, GTE, IN (value in list), NIN (value not in list), BTW (between, value is [min, max]), LIKE (substring match).',
  QLValue: 'Filter value. Accepts a scalar, or an array for the IN, NIN and BTW operators.',
  QLFilter: 'Single-field filter: a comparison operator plus the value to compare against.',
  QLTypeFilter: 'Filter applied to a related-entity field, addressed by a dot-separated path.',
  QLTypeFilterExpression: 'Filter on a related entity: a list of path-based terms.',
  QLFilterCondition: 'A single filter condition: field, operator, value and an optional nested path.',
  QLFilterGroup: 'Recursive logical group of filter conditions combined with AND/OR.',
  QLPagination: 'Pagination control: page (1-based), size (page size) and an optional count flag to include the total.',
  'QLPagination.page': '1-based page number.',
  'QLPagination.size': 'Number of records per page.',
  'QLPagination.count': 'When true, list queries also return the total number of matching records (across all pages) as `totalCount` next to the results (aggregate queries ignore this flag).',
  QLSortExpression: 'Sort specification: an ordered list of sort terms.',
  QLSort: 'A single sort term: the field to sort by and the direction.',
  'QLSort.field': 'Field name to sort by.',
  'QLSort.order': 'Sort direction (ASC or DESC).',
  QLSortOrder: 'Sort direction: ASC (ascending) or DESC (descending).',
  QLAggregationOperation: 'Aggregation operation: SUM, COUNT, AVG, MIN or MAX.',
  QLTypeAggregationExpression: 'Aggregation specification: a groupId field path to group by and a list of facts to compute.',
  QLTypeAggregationFact: 'A single aggregation fact: the operation, an output factName and the field path to aggregate.',
  IdInputType: 'Reference to a related entity by its id.',
});

/**
 * Curated fallback documentation for well-known operation-level arguments that
 * Simfinity injects into list and aggregate queries.
 */
const SIMFINITY_ARG_DOCS = Object.assign(Object.create(null), {
  id: 'Unique identifier (id) of the record.',
  pagination: 'Pagination: page (1-based), size, and an optional count flag (on list queries, the total number of matching records is returned as `totalCount` next to the results).',
  sort: 'Sort results by one or more fields (terms of { field, order: ASC | DESC }).',
  AND: 'Logical AND group(s): every nested condition or group must match.',
  OR: 'Logical OR group(s): at least one nested condition or group must match.',
  aggregation: 'Aggregation spec: groupId to group by and facts [{ operation: SUM | COUNT | AVG | MIN | MAX, factName, path }].',
});

/**
 * Follow validated-scalar chains (createValidatedScalar exposes
 * `baseScalarType`) to their root scalar; a cyclic chain stops where it
 * repeats. Local counterpart of the MongoDB adapter's resolveStorageScalar,
 * which MCP must not import.
 * @param {import('graphql').GraphQLScalarType} type
 * @returns {{ name: string }}
 */
const resolveRootScalar = (type) => {
  let base = type;
  const visited = new Set();
  while (base && base.baseScalarType && !visited.has(base)) {
    visited.add(base);
    base = base.baseScalarType;
  }
  return base;
};

const scalarPrimitiveSchema = (name) => {
  switch (name) {
    case 'Int':
      return { type: 'integer' };
    case 'Float':
      return { type: 'number' };
    case 'Boolean':
      return { type: 'boolean' };
    case 'ID':
    case 'String':
      return { type: 'string' };
    case 'Date':
      return { type: 'string', format: 'date' };
    case 'DateTime':
      return { type: 'string', format: 'date-time' };
    case 'Time':
      return { type: 'string', format: 'time' };
    default:
      return null;
  }
};

/**
 * Key under which simfinity-core's createValidatedScalar records the base a
 * validated scalar delegates to (see packages/core/src/scalars/factory.js).
 * Core does not export the symbol; Symbol.for gives both packages the same key.
 */
const VALIDATED_SCALAR_BASE = Symbol.for('simfinity.validatedScalarBase');

// Simfinity stores scalars with these root names as date/time instants; the
// application's scalar `serialize` decides their JSON form.
const DATE_TIME_SCALARS = new Set(['Date', 'DateTime', 'Time']);

/**
 * The GraphQL spec scalar whose JSON form a scalar's output takes, or null.
 * A validated scalar serializes through its base, so the walk follows only
 * createValidatedScalar links; any other scalar, including one with a
 * hand-set `baseScalarType` storage hint, serializes with its own `serialize`,
 * which can return anything (a Decimal hinted as Float may send '12.30').
 * @param {import('graphql').GraphQLScalarType} type
 * @returns {{ name: string }|null}
 */
const serializedSpecScalar = (type) => {
  const visited = new Set();
  for (let current = type; current && !visited.has(current); current = current[VALIDATED_SCALAR_BASE]) {
    if (isSpecifiedScalarType(current)) {
      return current;
    }
    visited.add(current);
  }
  return null;
};

/**
 * Resolve the JSON Schema for a GraphQL scalar.
 *
 * Input: custom validated scalars (created via createValidatedScalar, possibly
 * chained) and storage-hinted scalars expose a `baseScalarType`; the root of
 * that chain derives the underlying primitive, and Date-like roots (the names
 * Simfinity maps to Mongoose Date) carry a string `format` as a hint for the
 * value to send.
 *
 * Output: a primitive `type` is published only for GraphQL spec scalars and
 * validated scalars built on one, since any other scalar's `serialize`
 * decides its JSON form (Date/DateTime/Time may serialize to an ISO instant,
 * epoch milliseconds or 'YYYY-MM-DD'). Those map to an empty schema, with a
 * curated description for date/time roots that have none of their own.
 *
 * Unknown/opaque scalars map to an empty schema, meaning "any value is
 * accepted". A custom scalar's own description is published, falling back to
 * a curated one where it exists (e.g. QLValue); the generic descriptions of
 * the GraphQL built-in scalars are omitted.
 * @param {import('graphql').GraphQLScalarType} type
 * @param {{ output?: boolean }} [options] `output: true` for outputSchema positions
 * @returns {Object} JSON Schema fragment
 */
const scalarToJSONSchema = (type, { output = false } = {}) => {
  const root = resolveRootScalar(type);
  let schema;
  if (output) {
    const spec = serializedSpecScalar(type);
    schema = (spec && scalarPrimitiveSchema(spec.name)) || {};
  } else {
    schema = scalarPrimitiveSchema(root.name) || {};
  }
  const description = (!isSpecifiedScalarType(type) && type.description)
    || SIMFINITY_FILTER_DOCS[root.name]
    || (output && !schema.type && DATE_TIME_SCALARS.has(root.name)
      ? `Date/time value; its JSON form is defined by the server's ${type.name} scalar (commonly an ISO 8601 string).`
      : undefined);
  return description ? { ...schema, description } : schema;
};

const withDescription = (schema, description) => {
  if (!description) {
    return schema;
  }
  return { ...schema, description };
};

/**
 * Convert a GraphQL internal default value into its external (wire) form so
 * the JSON Schema `default` matches what a client must actually send — most
 * notably enum member NAMES rather than their internal values. Returns
 * undefined when the value cannot be represented (in which case no `default`
 * is emitted).
 * @param {*} value internal default value
 * @param {import('graphql').GraphQLInputType} type
 * @returns {*}
 */
const externalDefaultValue = (value, type) => {
  try {
    const ast = astFromValue(value, type);
    return ast ? valueFromASTUntyped(ast) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Make a JSON Schema fragment accept `null` in addition to its declared types.
 * Nullable GraphQL input and output positions allow explicit null. References
 * need a null alternative; unconstrained opaque scalar schemas already accept it.
 * @param {Object} schema
 * @returns {Object}
 */
const nullableSchema = (schema) => {
  if (schema && schema.$ref) {
    return { anyOf: [schema, { type: 'null' }] };
  }
  if (!schema || !schema.type) {
    return schema;
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('null')) {
    return schema;
  }
  const result = { ...schema, type: [...types, 'null'] };
  if (Array.isArray(result.enum) && !result.enum.includes(null)) {
    result.enum = [...result.enum, null];
  }
  return result;
};

/**
 * Register an enum type as a JSON Schema `$defs` entry (idempotent). The enum
 * member names are used as allowed values (what GraphQL expects through
 * `variableValues`), and the type description (or curated fallback) is attached.
 * @param {import('graphql').GraphQLEnumType} type
 * @param {Object} defs
 */
const ensureEnumDef = (type, defs) => {
  if (Object.hasOwn(defs, type.name)) {
    return;
  }
  const def = {
    type: 'string',
    enum: type.getValues().map((value) => value.name),
  };
  const description = type.description || SIMFINITY_FILTER_DOCS[type.name];
  if (description) {
    def.description = description;
  }
  defs[type.name] = def;
};

/**
 * Register an input object type as a JSON Schema `$defs` entry (idempotent). A
 * placeholder is inserted before recursing so that self-referential input types
 * (such as QLFilterGroup) resolve to a `$ref` instead of looping forever. Type
 * and field descriptions are propagated, with curated fallbacks for Simfinity's
 * synthetic filter types. Fields with a GraphQL default value carry a JSON
 * Schema `default` and are not listed as required (GraphQL fills them in).
 * @param {import('graphql').GraphQLInputObjectType} type
 * @param {Object} defs
 */
const ensureInputDef = (type, defs) => {
  if (Object.hasOwn(defs, type.name)) {
    return;
  }
  defs[type.name] = {};

  const properties = {};
  const required = [];
  for (const [fieldName, field] of Object.entries(type.getFields())) {
    const { schema, isRequired } = typeToJSONSchema(field.type, defs);
    const fieldDescription = field.description || SIMFINITY_FILTER_DOCS[`${type.name}.${fieldName}`];
    let property = withDescription(schema, fieldDescription);
    const hasDefault = field.defaultValue !== undefined;
    if (hasDefault) {
      const external = externalDefaultValue(field.defaultValue, field.type);
      if (external !== undefined) {
        property = { ...property, default: external };
      }
    }
    properties[fieldName] = property;
    if (isRequired && !hasDefault) {
      required.push(fieldName);
    }
  }

  const def = { type: 'object', properties };
  const description = type.description || SIMFINITY_FILTER_DOCS[type.name];
  if (description) {
    def.description = description;
  }
  if (required.length) {
    def.required = required;
  }
  defs[type.name] = def;
};

/**
 * Convert a GraphQL type into a JSON Schema fragment, collecting named input and
 * enum types into the shared `defs` map and returning whether the type is
 * required (non-null).
 * @param {import('graphql').GraphQLType} type
 * @param {Object} defs
 * @returns {{ schema: Object, isRequired: boolean }}
 */
function typeToJSONSchema(type, defs) {
  const isRequired = type instanceof GraphQLNonNull;
  const schema = unwrappedInputTypeToSchema(isRequired ? type.ofType : type, defs);
  if (isRequired && !schema.type && !schema.$ref) {
    // Opaque scalars accept arbitrary JSON values, but NonNull still excludes null.
    return { schema: { ...schema, not: { type: 'null' } }, isRequired };
  }
  return { schema: isRequired ? schema : nullableSchema(schema), isRequired };
}

function unwrappedInputTypeToSchema(type, defs) {
  if (type instanceof GraphQLList) {
    const inner = typeToJSONSchema(type.ofType, defs);
    return { type: 'array', items: inner.schema };
  }
  if (type instanceof GraphQLScalarType) {
    return scalarToJSONSchema(type);
  }
  if (type instanceof GraphQLEnumType) {
    ensureEnumDef(type, defs);
    return { $ref: `#/$defs/${type.name}` };
  }
  if (type instanceof GraphQLInputObjectType) {
    ensureInputDef(type, defs);
    return { $ref: `#/$defs/${type.name}` };
  }
  return {};
}

const resolveArgDescription = (arg) => {
  if (arg.description) {
    return arg.description;
  }
  const named = getNamedType(arg.type);
  if (named.name === 'QLFilter') {
    return `Filter on \`${arg.name}\` using { operator, value }.`;
  }
  if (named.name === 'QLTypeFilterExpression') {
    return `Filter on the related \`${arg.name}\` entity using { terms: [{ path, operator, value }] }.`;
  }
  return SIMFINITY_ARG_DOCS[arg.name];
};

const isDefType = (type) => type instanceof GraphQLInputObjectType || type instanceof GraphQLEnumType;

/**
 * A `$defs` registry shared by the tools of one buildToolDefinitions run. A
 * def depends only on its own type's fields, so each input or enum type is
 * converted once (ensureInputDef and ensureEnumDef skip names already in
 * `shared`) and every tool that reaches it gets the same object. `collect`
 * copies a type and the types its fields reach into one tool's `$defs` in
 * the pre-order ensureInputDef produces (its placeholder puts a type's key
 * before its fields' types), so each tool's serialized inputSchema is the
 * one a per-tool map builds.
 * @returns {{ shared: Object, collect: (type: import('graphql').GraphQLNamedType, defs: Object) => void }}
 */
const createDefRegistry = () => {
  const shared = Object.create(null);
  const dependencies = new Map();
  const dependenciesOf = (type) => {
    let list = dependencies.get(type);
    if (!list) {
      list = type instanceof GraphQLInputObjectType
        ? Object.values(type.getFields()).map((field) => getNamedType(field.type)).filter(isDefType)
        : [];
      dependencies.set(type, list);
    }
    return list;
  };
  const collect = (type, defs) => {
    if (!isDefType(type) || Object.hasOwn(defs, type.name)) {
      return;
    }
    defs[type.name] = shared[type.name];
    for (const dependency of dependenciesOf(type)) {
      collect(dependency, defs);
    }
  };
  return { shared, collect };
};

/**
 * Build the inputSchema of a list of arguments with the defs of `registry`;
 * see {@link graphqlArgsToJSONSchema}.
 * @param {ReadonlyArray<import('graphql').GraphQLArgument>} args
 * @param {{ shared: Object, collect: Function }} registry from {@link createDefRegistry}
 * @returns {Object}
 */
const argumentsToJSONSchema = (args, registry) => {
  const defs = Object.create(null);
  const properties = {};
  const required = [];

  for (const arg of args) {
    const { schema, isRequired } = typeToJSONSchema(arg.type, registry.shared);
    registry.collect(getNamedType(arg.type), defs);
    let property = withDescription(schema, resolveArgDescription(arg));
    const hasDefault = arg.defaultValue !== undefined;
    if (hasDefault) {
      const external = externalDefaultValue(arg.defaultValue, arg.type);
      if (external !== undefined) {
        property = { ...property, default: external };
      }
    }
    properties[arg.name] = property;
    if (isRequired && !hasDefault) {
      required.push(arg.name);
    }
  }

  // callTool also rejects undeclared keys the caller sent (MCP_UNKNOWN_ARGUMENT).
  const result = { type: 'object', properties, additionalProperties: false };
  if (required.length) {
    result.required = required;
  }
  if (Object.keys(defs).length) {
    result.$defs = defs;
  }
  return result;
};

/**
 * Build a field's inputSchema with the defs of `registry`; see
 * {@link graphqlArgsToJSONSchema}.
 * @param {import('graphql').GraphQLField} field
 * @param {{ shared: Object, collect: Function }} registry from {@link createDefRegistry}
 * @returns {Object}
 */
const argsToJSONSchema = (field, registry) => argumentsToJSONSchema(field.args || [], registry);

/**
 * Build the MCP `inputSchema` (JSON Schema) for a single GraphQL field by
 * converting every argument with full fidelity (scalars, enums, input objects,
 * lists, non-null wrappers and recursive types via `$defs`/`$ref`). Argument and
 * type descriptions are propagated, with curated fallbacks for Simfinity's
 * synthetic filter/pagination/sort/aggregation arguments. Arguments with a
 * GraphQL default value carry a JSON Schema `default` and are never required.
 * The arguments object is closed (`additionalProperties: false`): GraphQL
 * silently drops undeclared variables, so a misspelled filter or a guessed
 * `limit` or `dryRun` would otherwise be ignored while the tool runs. Every
 * call returns new objects; generated tools share their `$defs` entries
 * instead (see {@link createDefRegistry}).
 * @param {import('graphql').GraphQLField} field
 * @returns {Object} JSON Schema describing the tool input
 */
export const graphqlArgsToJSONSchema = (field) => argsToJSONSchema(field, createDefRegistry());

const hasRequiredArgs = (field) => (field.args || [])
  .some((arg) => arg.type instanceof GraphQLNonNull && arg.defaultValue === undefined);

/**
 * Which virtual fields (`extensions.virtual`, read with core's
 * virtualFieldOptions) a generated selection set and output schema include.
 * 'all' treats them like any other field; 'select' keeps only those whose
 * `mcp` option is 'select'. A virtual field's resolver runs once per record,
 * so tools whose root field returns a list, such as list tools, use 'select',
 * and every tool switches to 'select' below a list position (see
 * {@link virtualFieldsInside}).
 * @param {import('graphql').GraphQLType} type the type the selection starts at
 * @returns {'all'|'select'}
 */
const virtualFieldsFor = (type) => (isListType(type) ? 'select' : 'all');

/**
 * The {@link virtualFieldsFor} mode inside an object field's value: 'select'
 * when the field holds a list, such as a nested collection or an embedded
 * list, whose items would each run the resolvers of the virtual fields
 * selected in them; otherwise the mode of the field's parent.
 * @param {import('graphql').GraphQLField} field
 * @param {'all'|'select'} virtuals the mode of the field's parent
 * @returns {'all'|'select'}
 */
const virtualFieldsInside = (field, virtuals) => (isListType(field.type) ? 'select' : virtuals);

/**
 * Whether a generated selection set and output schema include a field: never
 * with a required argument that has no default, and a virtual field only as
 * {@link virtualFieldsFor} allows.
 * @param {import('graphql').GraphQLField} field
 * @param {'all'|'select'} virtuals
 * @returns {boolean}
 */
const isSelectable = (field, virtuals) => {
  if (hasRequiredArgs(field)) {
    return false;
  }
  if (virtuals === 'all') {
    return true;
  }
  const options = virtualFieldOptions(field);
  return !options || options.mcp === 'select';
};

const NESTED_COLLECTIONS = ['all', 'none'];

/**
 * Normalize a `nestedCollections` option: unset (undefined or null) means
 * 'all', the 3.5.9 selection. Any value other than 'all' or 'none' throws
 * MCP_INVALID_OPTIONS.
 * @param {*} value
 * @param {string} name option path, for the error message
 * @returns {'all'|'none'}
 */
const normalizeNestedCollections = (value, name) => {
  if (value == null) {
    return 'all';
  }
  if (NESTED_COLLECTIONS.includes(value)) {
    return value;
  }
  throw new SimfinityError(`${name} must be 'all' or 'none', got ${describeCap(value)}`, 'MCP_INVALID_OPTIONS', 500);
};

/**
 * A nested collection: an object list field that takes a `pagination`
 * argument. Core generates one for every non-embedded one-to-many relation
 * and resolves it with one query per parent row; embedded lists take no
 * arguments.
 * @param {import('graphql').GraphQLField} field
 * @returns {boolean}
 */
const isNestedCollection = (field) => isListType(field.type) && hasArg(field, 'pagination');

/**
 * Whether the selection set and the output schema expand an object field.
 * @param {import('graphql').GraphQLField} field
 * @param {import('graphql').GraphQLObjectType} fieldNamed the field's named type
 * @param {number} depth remaining nesting depth
 * @param {'all'|'none'} collections
 * @param {'all'|'select'} virtuals from {@link virtualFieldsFor}
 * @param {Set<string>} visited already-expanded object type names
 * @returns {boolean}
 */
const expandsObjectField = (field, fieldNamed, depth, collections, virtuals, visited) => depth > 0
  && !visited.has(fieldNamed.name)
  && isSelectable(field, virtuals)
  && !(collections === 'none' && isNestedCollection(field));

/**
 * Auto-generate a GraphQL selection set string for a field's return type so MCP
 * callers only need to supply arguments. Every scalar/enum field without
 * required arguments (`id` included) is selected; object fields are expanded
 * up to `depth` levels. Interface/union return types and object types with no
 * selectable leaves fall back to `__typename` so the generated document is
 * always statically valid. Cycles are avoided via the `visited` set. With
 * `nestedCollections: 'none'`, nested collections (see
 * {@link isNestedCollection}) are left out, and with `virtuals: 'select'`,
 * which applies below every list position (see {@link virtualFieldsInside}),
 * virtual fields other than `mcp: 'select'` ones (see {@link isSelectable}).
 * @param {import('graphql').GraphQLType} type return type of the field
 * @param {number} depth remaining nesting depth for object expansion
 * @param {'all'|'none'} [collections] from {@link normalizeNestedCollections}
 * @param {'all'|'select'} [virtuals] from {@link virtualFieldsFor}
 * @param {Set<string>} visited already-expanded object type names
 * @returns {string} selection set (with leading space) or empty string for leaves
 */
const buildSelectionSet = (type, depth, collections = 'all', virtuals = 'all', visited = new Set()) => {
  const named = getNamedType(type);
  if (named instanceof GraphQLScalarType || named instanceof GraphQLEnumType) {
    return '';
  }
  if (!(named instanceof GraphQLObjectType)) {
    // Interface/union: a selection set is mandatory; __typename is always valid.
    return ' { __typename }';
  }

  const fields = named.getFields();
  const lines = [];
  const nextVisited = new Set(visited).add(named.name);

  for (const [fieldName, field] of Object.entries(fields)) {
    const fieldNamed = getNamedType(field.type);
    if (fieldNamed instanceof GraphQLScalarType || fieldNamed instanceof GraphQLEnumType) {
      if (isSelectable(field, virtuals)) {
        lines.push(fieldName);
      }
    } else if (fieldNamed instanceof GraphQLObjectType) {
      if (expandsObjectField(field, fieldNamed, depth, collections, virtuals, nextVisited)) {
        // An object type always yields ' { ... }', at worst ' { __typename }'.
        lines.push(`${fieldName}${buildSelectionSet(field.type, depth - 1, collections, virtualFieldsInside(field, virtuals), nextVisited)}`);
      }
    }
  }

  if (lines.length === 0) {
    lines.push('__typename');
  }
  return ` { ${lines.join(' ')} }`;
};

/**
 * Normalize a user-provided explicit selection (from `toolOverrides`) into the
 * leading-space `{ ... }` form `buildOperation` expects. Accepts either
 * `'{ id title }'` or `'id title'`.
 * @param {string} selection
 * @returns {string}
 */
const normalizeSelection = (selection) => {
  const trimmed = String(selection).trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.startsWith('{') ? ` ${trimmed}` : ` { ${trimmed} }`;
};

/**
 * Build a JSON Schema describing a field's return type, mirroring the inclusion
 * rules of {@link buildSelectionSet} (scalars/enums always; object fields up to
 * `depth`, without nested collections under `nestedCollections: 'none'`;
 * virtual fields as `virtuals` allows; `__typename` fallback) so the schema
 * matches what the tool actually returns. Every nullable GraphQL position
 * accepts `null` in the schema. Scalars use the output mapping of
 * {@link scalarToJSONSchema}. GraphQL type and field descriptions are
 * propagated.
 * @param {import('graphql').GraphQLType} type
 * @param {number} depth
 * @param {'all'|'none'} [collections]
 * @param {'all'|'select'} [virtuals] from {@link virtualFieldsFor}
 * @param {Set<string>} visited
 * @returns {Object} JSON Schema for the return type
 */
const returnTypeToSchema = (type, depth, collections = 'all', virtuals = 'all', visited = new Set()) => {
  if (type instanceof GraphQLNonNull) {
    return unwrappedReturnTypeToSchema(type.ofType, depth, collections, virtuals, visited);
  }
  return nullableSchema(unwrappedReturnTypeToSchema(type, depth, collections, virtuals, visited));
};

function unwrappedReturnTypeToSchema(type, depth, collections, virtuals, visited) {
  if (type instanceof GraphQLList) {
    return { type: 'array', items: returnTypeToSchema(type.ofType, depth, collections, virtuals, visited) };
  }
  if (type instanceof GraphQLScalarType) {
    return scalarToJSONSchema(type, { output: true });
  }
  if (type instanceof GraphQLEnumType) {
    return { type: 'string', enum: type.getValues().map((value) => value.name) };
  }
  if (!(type instanceof GraphQLObjectType)) {
    return {};
  }

  const fields = type.getFields();
  const properties = {};
  const nextVisited = new Set(visited).add(type.name);

  for (const [fieldName, field] of Object.entries(fields)) {
    const fieldNamed = getNamedType(field.type);
    if (fieldNamed instanceof GraphQLScalarType || fieldNamed instanceof GraphQLEnumType) {
      if (isSelectable(field, virtuals)) {
        properties[fieldName] = withDescription(
          returnTypeToSchema(field.type, depth, collections, virtuals, nextVisited),
          field.description,
        );
      }
    } else if (fieldNamed instanceof GraphQLObjectType) {
      if (expandsObjectField(field, fieldNamed, depth, collections, virtuals, nextVisited)) {
        // Never empty: an object schema has at least the __typename fallback.
        properties[fieldName] = withDescription(
          returnTypeToSchema(field.type, depth - 1, collections, virtualFieldsInside(field, virtuals), nextVisited),
          field.description,
        );
      }
    }
  }

  if (Object.keys(properties).length === 0) {
    properties.__typename = { type: 'string' };
  }

  const schema = { type: 'object', properties };
  if (type.description) {
    schema.description = type.description;
  }
  return schema;
}

/**
 * Build the MCP `outputSchema` for a field. The result is wrapped under the
 * field name so that `structuredContent`, the GraphQL `data` (shaped
 * `{ [fieldName]: value }`), conforms to the schema. buildToolDefinitions adds
 * the keys MCP places next to it (`totalCount`, `truncated`).
 * @param {string} fieldName
 * @param {import('graphql').GraphQLField} field
 * @param {number} selectionDepth
 * @param {'all'|'none'} [collections]
 * @param {'all'|'select'} [virtuals] from {@link virtualFieldsFor}
 * @returns {Object} JSON Schema describing the tool output
 */
const buildOutputSchema = (fieldName, field, selectionDepth, collections = 'all', virtuals = 'all') => ({
  type: 'object',
  properties: {
    [fieldName]: returnTypeToSchema(field.type, selectionDepth, collections, virtuals),
  },
});

/**
 * Build the `outputSchema` of a virtual field tool (see
 * {@link buildVirtualFieldTools}): the GraphQL `data`
 * `{ [byIdName]: { [fieldName]: value } | null }`. The field's value follows
 * the rules of {@link returnTypeToSchema}, as a root field's does, starting
 * with its parent type already visited, as in the by-ID tool's selection.
 * @param {{ byIdName: string, byIdField: import('graphql').GraphQLField,
 *   entityType: import('graphql').GraphQLObjectType, fieldName: string,
 *   field: import('graphql').GraphQLField }} target
 * @param {number} selectionDepth
 * @param {'all'|'none'} collections
 * @param {'all'|'select'} virtuals from {@link virtualFieldsFor}
 * @returns {Object}
 */
const buildVirtualFieldOutputSchema = ({
  byIdName, byIdField, entityType, fieldName, field,
}, selectionDepth, collections, virtuals) => {
  const parent = {
    type: 'object',
    properties: {
      [fieldName]: withDescription(
        returnTypeToSchema(field.type, selectionDepth, collections, virtuals, new Set([entityType.name])),
        field.description,
      ),
    },
  };
  if (entityType.description) {
    parent.description = entityType.description;
  }
  return {
    type: 'object',
    properties: {
      [byIdName]: byIdField.type instanceof GraphQLNonNull ? parent : nullableSchema(parent),
    },
  };
};

/**
 * The variable definition that feeds `arg`, with its default as a GraphQL
 * literal when it has one.
 * @param {import('graphql').GraphQLArgument} arg
 * @returns {string}
 */
const variableDefinition = (arg) => {
  const declaration = `$${arg.name}: ${arg.type.toString()}`;
  if (arg.defaultValue === undefined) {
    return declaration;
  }
  try {
    const defaultAST = astFromValue(arg.defaultValue, arg.type);
    if (defaultAST) {
      return `${declaration} = ${print(defaultAST)}`;
    }
  } catch {
    // Opaque custom scalar defaults may have no literal representation.
  }
  // A nullable variable may feed a non-null argument with a location
  // default. Omission uses that default; explicit null still fails coercion.
  const variableType = arg.type instanceof GraphQLNonNull ? arg.type.ofType : arg.type;
  return `$${arg.name}: ${variableType.toString()}`;
};

/** `name: $name` for every argument, comma-separated. */
const argumentUsage = (args) => args
  .map((arg) => `${arg.name}: $${arg.name}`)
  .join(', ');

/**
 * Build the GraphQL operation document string for a field. All arguments are
 * declared as variables so the MCP caller supplies them via `variableValues`.
 * @param {'query'|'mutation'} kind
 * @param {string} fieldName
 * @param {import('graphql').GraphQLField} field
 * @param {string} selection selection set (leading-space form) or empty string
 * @returns {string} GraphQL operation source
 */
const buildOperation = (kind, fieldName, field, selection) => {
  const args = field.args || [];
  const varDefs = args.map(variableDefinition).join(', ');
  const argUsage = argumentUsage(args);

  const header = varDefs ? `${kind} ${fieldName}Operation(${varDefs})` : `${kind} ${fieldName}Operation`;
  const call = argUsage ? `${fieldName}(${argUsage})` : fieldName;
  return `${header} {\n  ${call}${selection}\n}`;
};

/**
 * The `id` argument of a virtual field tool (see {@link buildVirtualFieldTools}):
 * the by-ID query's, made non-null, because without it the query reads no
 * record. The tool's input schema and its operation's variable both declare
 * it, so a call that omits `id` or sends null fails variable coercion, as an
 * invalid request, instead of returning the null of a missing record.
 * @param {{ byIdField: import('graphql').GraphQLField }} target
 * @returns {import('graphql').GraphQLArgument}
 */
const requiredIdArgument = ({ byIdField }) => {
  const [idArg] = byIdField.args;
  return idArg.type instanceof GraphQLNonNull ? idArg : { ...idArg, type: new GraphQLNonNull(idArg.type) };
};

/**
 * Build the operation of a virtual field tool: the by-ID query, with the
 * tool's required `id`, selecting only the virtual field with its arguments,
 * such as `query shop_busyRangesOperation($id: ID!, $date: String!) {
 * shop(id: $id) { busyRanges(date: $date) { start end } } }` (over four lines).
 * @param {string} operationName unprefixed tool name
 * @param {{ byIdName: string, fieldName: string,
 *   field: import('graphql').GraphQLField }} target
 * @param {import('graphql').GraphQLArgument} idArg from {@link requiredIdArgument},
 *   the one the tool's input schema declares
 * @param {string} selection selection set (leading-space form) or empty string
 * @returns {string} GraphQL operation source
 */
const buildVirtualFieldOperation = (operationName, { byIdName, fieldName, field }, idArg, selection) => {
  const fieldArgs = field.args;
  const varDefs = [idArg, ...fieldArgs].map(variableDefinition).join(', ');
  return `query ${operationName}Operation(${varDefs}) {\n  ${byIdName}(${argumentUsage([idArg])}) {\n`
    + `    ${fieldName}(${argumentUsage(fieldArgs)})${selection}\n  }\n}`;
};

const isListType = (type) => {
  const inner = type instanceof GraphQLNonNull ? type.ofType : type;
  return inner instanceof GraphQLList;
};

const hasArg = (field, name) => (field.args || []).some((arg) => arg.name === name);

// Operation names core stamps on generated mutation fields
// (extensions.simfinityMutation.operation; see buildMutation in core's runtime.js).
const MUTATION_OPERATIONS = Object.assign(Object.create(null), {
  save: 'add',
  update: 'update',
  delete: 'delete',
  state_changed: 'transition',
  custom_mutation: 'custom',
});

/**
 * Classify a root field into a logical operation kind so descriptions, titles
 * and annotations can be tailored. Generated list and aggregate queries carry
 * their operation in `extensions.simfinityQuery`, so a list query whose type
 * declares a field named `aggregation` (and therefore has an `aggregation`
 * filter argument) stays a list. Other queries are classified structurally: a
 * list needs a `pagination` argument and a single-record query an `id`
 * argument; any other query is a read-only 'customQuery'. Generated mutations
 * carry their operation in `extensions.simfinityMutation`. Without it (an
 * older core, or a schema rebuilt from SDL or introspection), CRUD mutations
 * are recognized by the placeholder description Simfinity stamps on them
 * ('add'/'update'/'delete') together with the matching name prefix. Every
 * other mutation is 'custom', including a state-machine action or a custom
 * mutation whose name happens to start with add/update/delete; a name alone
 * never makes a CRUD tool.
 * @param {'query'|'mutation'} kind
 * @param {string} fieldName
 * @param {import('graphql').GraphQLField} field
 * @returns {'single'|'list'|'aggregate'|'customQuery'|'add'|'update'|'delete'|'transition'|'custom'}
 */
const classifyOperation = (kind, fieldName, field) => {
  if (kind === 'query') {
    const query = field.extensions && field.extensions.simfinityQuery;
    const generated = query ? query.operation : undefined;
    if (generated === 'aggregate') {
      return 'aggregate';
    }
    if (generated === 'find') {
      return 'list';
    }
    if (hasArg(field, 'aggregation')) {
      return 'aggregate';
    }
    if (isListType(field.type)) {
      return hasArg(field, 'pagination') ? 'list' : 'customQuery';
    }
    return hasArg(field, 'id') ? 'single' : 'customQuery';
  }
  const mutation = field.extensions && field.extensions.simfinityMutation;
  if (mutation && MUTATION_OPERATIONS[mutation.operation]) {
    return MUTATION_OPERATIONS[mutation.operation];
  }
  // Generated CRUD mutations carry BOTH the placeholder description and the
  // name prefix; requiring the conjunction avoids misreading a custom mutation
  // that happens to have one of them (e.g. registerMutation('reindex', 'update')).
  if (field.description === 'add' && fieldName.startsWith('add')) {
    return 'add';
  }
  if (field.description === 'update' && fieldName.startsWith('update')) {
    return 'update';
  }
  if (field.description === 'delete' && fieldName.startsWith('delete')) {
    return 'delete';
  }
  return 'custom';
};

/**
 * Whether a mutation's arguments can carry collection items to insert: an
 * input object field named `added` holding a list, the shape Simfinity
 * generates for non-embedded one-to-many collections, at any nesting depth
 * (`lines.updated[].notes.added` included).
 * @param {import('graphql').GraphQLField} field
 * @returns {boolean}
 */
const acceptsAddedItems = (field) => {
  const visited = new Set();
  const visit = (type) => {
    const named = getNamedType(type);
    if (!(named instanceof GraphQLInputObjectType) || visited.has(named)) {
      return false;
    }
    visited.add(named);
    return Object.values(named.getFields()).some((inputField) => (
      (inputField.name === 'added' && isListType(inputField.type)) || visit(inputField.type)
    ));
  };
  return (field.args || []).some((arg) => visit(arg.type));
};

// Simfinity sets these trivial placeholder descriptions on generated CRUD
// mutations; they carry no useful information for an agent, so we ignore them
// and synthesize a richer description instead.
const PLACEHOLDER_DESCRIPTIONS = new Set(['add', 'update', 'delete']);

const buildToolDescription = (op, fieldName, field, entityType) => {
  if (field.description && !PLACEHOLDER_DESCRIPTIONS.has(field.description)) {
    return field.description;
  }
  const entity = entityType ? entityType.name : 'record';
  const entityDoc = entityType && entityType.description ? ` ${entityType.description}` : '';

  switch (op) {
    case 'single':
      return `Fetch a single ${entity} by id. Returns the matching ${entity} or null.${entityDoc}`;
    case 'list':
      return `List and search ${entity} records. Supports per-field filters (operators: ${FILTER_OPERATORS_TEXT}), nested AND/OR filter groups, pagination (page/size) and sorting. Returns an array of ${entity}.${entityDoc}`;
    case 'aggregate':
      return `Run grouped aggregations (SUM, COUNT, AVG, MIN, MAX) over ${entity} records. Provide \`aggregation\` with a groupId and facts. Supports per-field filters (operators: ${FILTER_OPERATORS_TEXT}), nested AND/OR filter groups, pagination (page/size) and sorting, like the list query. Returns grouped aggregation results (groupId, facts).${entityDoc}`;
    case 'add':
      return `Create a new ${entity}. Provide \`input\` with the fields to set. Returns the created ${entity}.${entityDoc}`;
    case 'update':
      return `Update an existing ${entity}. Provide \`input\` including the \`id\` and the fields to change. Returns the updated ${entity}.${entityDoc}`;
    case 'delete':
      return `Delete a ${entity} by id. Returns the deleted ${entity}.${entityDoc}`;
    case 'customQuery':
      return `Run the read-only \`${fieldName}\` query.${entityType ? ` Returns ${entity} data.` : ''}${entityDoc}`;
    case 'transition': {
      // onStateChanged checks the current state, then updates the record
      // with the rest of `input` and the target state.
      const { action, from, to } = field.extensions.simfinityMutation;
      const states = from && to
        ? ` It is allowed only while the ${entity} is in state ${from} and moves it to ${to}.`
        : '';
      return `Apply the \`${action || fieldName}\` state transition to an existing ${entity}.${states} Provide \`input\` with the record's \`id\`; other fields in \`input\` are updated too. Returns the updated ${entity}.${entityDoc}`;
    }
    default:
      return `Execute the \`${fieldName}\` operation.${entityDoc}`;
  }
};

const buildToolTitle = (op, fieldName, entityType) => {
  const entity = entityType ? entityType.name : fieldName;
  switch (op) {
    case 'single':
      return `Get ${entity}`;
    case 'list':
      return `List ${entity}`;
    case 'aggregate':
      return `Aggregate ${entity}`;
    case 'add':
      return `Create ${entity}`;
    case 'update':
      return `Update ${entity}`;
    case 'delete':
      return `Delete ${entity}`;
    default:
      return fieldName;
  }
};

/**
 * Description of a virtual field tool (see {@link buildVirtualFieldTools}):
 * the field's own description, or a generated one.
 * @param {string} fieldName
 * @param {import('graphql').GraphQLField} field
 * @param {import('graphql').GraphQLObjectType} entityType the type that declares the field
 * @returns {string}
 */
const buildVirtualFieldToolDescription = (fieldName, field, entityType) => {
  if (field.description) {
    return field.description;
  }
  const entity = entityType.name;
  const entityDoc = entityType.description ? ` ${entityType.description}` : '';
  return `Read the \`${fieldName}\` field of a single ${entity} by id, passing the field's arguments. Returns the ${entity} with only that field, or null when no ${entity} with that id exists or is visible.${entityDoc}`;
};

/**
 * MCP behavioral hints for a tool. `idempotentHint` describes the stored
 * data only: a repeated call runs middleware and controller hooks again.
 * An update is idempotent unless its input can carry collection items to
 * insert (`added`), which create new child records on every call. A delete is
 * idempotent because a repeat deletes nothing more; it still calls
 * controller.onDelete, with null since the record is gone, so onDelete hooks
 * must tolerate null. Transitions and custom mutations get no hints beyond
 * readOnlyHint: false.
 * @param {string} op from {@link classifyOperation}
 * @param {string} title
 * @param {import('graphql').GraphQLField} field
 * @returns {Object}
 */
const buildAnnotations = (op, title, field) => {
  const base = { title, openWorldHint: false };
  switch (op) {
    case 'single':
    case 'list':
    case 'aggregate':
    case 'customQuery':
    case 'virtualField':
      return { ...base, readOnlyHint: true };
    case 'update':
      return { ...base, readOnlyHint: false, idempotentHint: !acceptsAddedItems(field) };
    case 'delete':
      return {
        ...base, readOnlyHint: false, destructiveHint: true, idempotentHint: true,
      };
    default:
      return { ...base, readOnlyHint: false };
  }
};

/** Normalize an option that accepts a single value or an array into an array. */
const toArray = (value) => {
  if (value == null) {
    return null;
  }
  return Array.isArray(value) ? value : [value];
};

const matchesSelector = (selectors, names, kind) => selectors
  .some((selector) => selector === kind || names.includes(selector));

const isIncluded = ({
  names, kind, entityName, include, exclude, includeTypes, excludeTypes,
}) => {
  if (exclude && matchesSelector(exclude, names, kind)) {
    return false;
  }
  if (excludeTypes && entityName && excludeTypes.includes(entityName)) {
    return false;
  }
  if (include && !matchesSelector(include, names, kind)) {
    return false;
  }
  if (includeTypes && !(entityName && includeTypes.includes(entityName))) {
    return false;
  }
  return true;
};

const noop = () => {};

/**
 * Combine abort signals into one; call `release` once the request settles.
 * AbortSignal.any is missing on Node.js 19 and 20.0–20.2, which the engines
 * range includes, so listeners stand in for it there. `release` removes them,
 * so a long-lived caller signal keeps none, and they remove themselves when a
 * signal aborts.
 * @param {Array<AbortSignal|undefined>} signals
 * @returns {{ signal: AbortSignal|undefined, release: () => void }}
 */
const combineAbortSignals = (signals) => {
  const list = signals.filter(Boolean);
  if (list.length <= 1) {
    return { signal: list[0], release: noop };
  }
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any(list), release: noop };
  }
  const controller = new AbortController();
  const aborted = list.find((signal) => signal.aborted);
  if (aborted) {
    controller.abort(aborted.reason);
    return { signal: controller.signal, release: noop };
  }
  const listeners = [];
  const release = () => {
    listeners.forEach(([signal, listener]) => signal.removeEventListener('abort', listener));
  };
  list.forEach((signal) => {
    const listener = () => {
      release();
      controller.abort(signal.reason);
    };
    listeners.push([signal, listener]);
    signal.addEventListener('abort', listener, { once: true });
  });
  return { signal: controller.signal, release };
};

/**
 * Wait `ms` milliseconds, rejecting with `signal.reason` (the value an aborted
 * fetch rejects with) as soon as `signal` aborts, or at once when it already
 * has, so a cancelled call does not outlive its retry backoff. The listener is
 * removed when the timer fires, so a long-lived caller signal keeps none.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) {
    reject(signal.reason);
    return;
  }
  // A signal-like object that is not an EventTarget cannot cut the wait short.
  const listening = !!signal && typeof signal.addEventListener === 'function';
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal.reason);
  };
  const timer = setTimeout(() => {
    if (listening) {
      signal.removeEventListener('abort', onAbort);
    }
    resolve();
  }, ms);
  if (listening) {
    signal.addEventListener('abort', onAbort, { once: true });
  }
});

/** Default `retry.maxRetryAfterMs`: the longest Retry-After a retry waits for. */
const DEFAULT_MAX_RETRY_AFTER_MS = 10000;

const HTTP_DATE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HTTP_DATE_MONTH = `(?<month>${HTTP_DATE_MONTHS.join('|')})`;
const HTTP_DATE_DAY_NAME = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const HTTP_DATE_TIME = '(?<hour>\\d{2}):(?<minute>\\d{2}):(?<second>\\d{2})';

/** The three HTTP-date grammars of RFC 9110 §5.6.7, which are case-sensitive and all in GMT. */
const HTTP_DATE_FORMATS = [
  // IMF-fixdate: Sun, 06 Nov 1994 08:49:37 GMT
  new RegExp(`^${HTTP_DATE_DAY_NAME}, (?<day>\\d{2}) ${HTTP_DATE_MONTH} (?<year>\\d{4}) ${HTTP_DATE_TIME} GMT$`),
  // rfc850-date: Sunday, 06-Nov-94 08:49:37 GMT
  new RegExp(`^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (?<day>\\d{2})-${HTTP_DATE_MONTH}-(?<year>\\d{2}) ${HTTP_DATE_TIME} GMT$`),
  // asctime-date: Sun Nov  6 08:49:37 1994
  new RegExp(`^${HTTP_DATE_DAY_NAME} ${HTTP_DATE_MONTH} (?<day>\\d{2}| \\d) ${HTTP_DATE_TIME} (?<year>\\d{4})$`),
];

/**
 * An HTTP-date as epoch milliseconds, or NaN when `text` is not one. Unlike
 * Date.parse, it rejects other date-like text (such as "May 2030") and reads
 * asctime as GMT rather than in the process time zone. A two-digit RFC 850
 * year is the one with those digits from 49 years before to 50 years after
 * the current year: a date more than 50 years ahead is in the past.
 * @param {string} text
 * @param {number} now
 * @returns {number}
 */
const parseHTTPDate = (text, now) => {
  const groups = HTTP_DATE_FORMATS.map((format) => format.exec(text)?.groups).find(Boolean);
  if (!groups) {
    return Number.NaN;
  }
  let year = Number(groups.year);
  if (groups.year.length === 2) {
    const current = new Date(now).getUTCFullYear();
    year += current - (current % 100);
    if (year > current + 50) {
      year -= 100;
    } else if (year <= current - 50) {
      year += 100;
    }
  }
  const day = Number(groups.day);
  const [hour, minute, second] = [groups.hour, groups.minute, groups.second].map(Number);
  const midnight = Date.UTC(year, HTTP_DATE_MONTHS.indexOf(groups.month), day);
  // Second 60 is a leap second; other out-of-range values (31 Feb, 24:00:00) are invalid.
  if (new Date(midnight).getUTCDate() !== day || hour > 23 || minute > 59 || second > 60) {
    return Number.NaN;
  }
  return midnight + (hour * 3600 + minute * 60 + second) * 1000;
};

/**
 * The wait a response's Retry-After header asks for, in milliseconds, or
 * undefined when it has none or an invalid one. Delta-seconds and the three
 * HTTP-date forms (IMF-fixdate, RFC 850 and asctime, all GMT) are accepted
 * (RFC 9110 §10.2.3, §5.6.7); a date in the past asks for no wait. The
 * header is read defensively, since an application fetch or a test stub may
 * return a response without a usable `headers`.
 * @param {Object} response
 * @param {number} [now]
 * @returns {number|undefined}
 */
const retryAfterMs = (response, now = Date.now()) => {
  let value;
  try {
    value = response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('retry-after')
      : null;
  } catch {
    return undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    return Number(text) * 1000;
  }
  const date = parseHTTPDate(text, now);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
};

const remoteTransportError = (message, code, extra = {}) => ({
  errors: [{ message, extensions: { code, ...extra } }],
});

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const isGraphQLResponse = (body) => {
  if (!isRecord(body)) {
    return false;
  }
  const hasErrors = Object.hasOwn(body, 'errors');
  if (hasErrors && (!Array.isArray(body.errors) || body.errors.length === 0
    || !body.errors.every((error) => isRecord(error) && typeof error.message === 'string'))) {
    return false;
  }
  if (Object.hasOwn(body, 'data') && body.data !== null && !isRecord(body.data)) {
    return false;
  }
  return hasErrors || isRecord(body.data);
};

/** Node's timer ceiling: AbortSignal.timeout turns a longer delay into 1 ms. */
const MAX_REMOTE_TIMEOUT_MS = 2147483647;

const invalidExecutionConfig = (message) => new SimfinityError(message, 'MCP_INVALID_EXECUTION_CONFIG', 500);

/**
 * Normalize remote `execution.timeoutMs` to whole milliseconds, or undefined
 * for no timeout. A falsy value (omitted, null, false, 0, '', NaN) and a
 * numeric string equal to 0 disable the timeout. Positive numbers, bigints
 * and numeric strings are converted with Number(), rounded up (so a fraction
 * never shortens or disables the timeout) and capped at
 * MAX_REMOTE_TIMEOUT_MS. Any other value (Infinity, negative numbers, true,
 * blank or non-numeric strings, objects) made every call fail inside
 * AbortSignal.timeout, so it is a configuration error.
 * @param {*} value
 * @returns {number|undefined}
 */
const normalizeTimeoutMs = (value) => {
  if (!value) {
    return undefined;
  }
  let ms = Number.NaN;
  if (typeof value === 'number' || typeof value === 'bigint') {
    ms = Number(value);
  } else if (typeof value === 'string' && value.trim() !== '') {
    ms = Number(value);
  }
  if (ms === 0) {
    return undefined;
  }
  if (ms > 0 && Number.isFinite(ms)) {
    return Math.min(Math.ceil(ms), MAX_REMOTE_TIMEOUT_MS);
  }
  throw invalidExecutionConfig(`execution.timeoutMs must be a positive, finite number of milliseconds, got ${describeCap(value)}; omit it, or pass 0, false or null, to disable the timeout`);
};

const ENDPOINT_CREDENTIALS_PROBLEM = 'execution.endpoint must not include a username or password; send credentials through execution.headers';

/**
 * The absolute URL `endpoint` names, or null when it names none. A Request
 * carries its own URL; any other value is converted to a string, as fetch
 * does, and a relative or unparsable one names none.
 * @param {*} endpoint
 * @returns {URL|null}
 */
const parseEndpoint = (endpoint) => {
  try {
    return new URL(typeof Request === 'function' && endpoint instanceof Request ? endpoint.url : String(endpoint));
  } catch {
    return null;
  }
};

/**
 * Why fetch cannot request `endpoint`, or null when it can. fetch only
 * requests an absolute http(s) URL without a username or password, and its
 * error for any other value quotes the URL, which may carry credentials or an
 * API key. The message never quotes it.
 * @param {*} endpoint
 * @returns {string|null}
 */
const remoteEndpointProblem = (endpoint) => {
  const url = parseEndpoint(endpoint);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return 'execution.endpoint must be an absolute http(s) URL, such as https://api.example.com/graphql';
  }
  if (url.username || url.password) {
    return ENDPOINT_CREDENTIALS_PROBLEM;
  }
  return null;
};

/**
 * Why `headers` cannot serve as remote request headers, or null when it can.
 * Falsy means no extra headers. Judged from the container alone, so no header
 * value (lazy getters included) is read: a promise or a function would send
 * no credentials, and an iterator would be used up by the first request.
 * @param {*} headers
 * @returns {string|null}
 */
const remoteHeadersProblem = (headers) => {
  if (!headers) {
    return null;
  }
  let got = null;
  if (typeof headers !== 'object' || isThenable(headers)) {
    got = describeValue(headers);
  } else if (typeof headers.next === 'function') {
    got = 'an iterator, which only the first request could read';
  }
  if (!got) {
    return null;
  }
  return `execution.headers must be an object of header names to values, a Headers instance, a Map or an array of [name, value] pairs, got ${got}; omit it, or pass null or false, to send no extra headers`;
};

/**
 * Build the remote request headers from `execution.headers`, read on every
 * attempt so later changes (e.g. a rotated token) apply. Header names are
 * case-insensitive: a Content-Type in any casing replaces the JSON default
 * and is sent once. A plain object contributes its own enumerable string
 * keys, as spreading it did; a Headers instance, a Map or an array its
 * [name, value] entries. Headers validates every name and value; errors name
 * the header but never quote a value, which may be a credential.
 * @param {*} headers
 * @returns {Record<string, string>} lowercase names
 */
const buildRemoteHeaders = (headers) => {
  const problem = remoteHeadersProblem(headers);
  if (problem) {
    throw new Error(problem);
  }
  let entries = [];
  if (headers) {
    entries = typeof headers[Symbol.iterator] === 'function' ? headers : Object.entries(headers);
  }
  const merged = new Headers();
  let position = 0;
  for (const entry of entries) {
    position += 1;
    const pair = entry !== null && typeof entry === 'object' && typeof entry[Symbol.iterator] === 'function'
      ? Array.from(entry)
      : [];
    if (pair.length !== 2) {
      throw new Error(`execution.headers entry ${position} is not a [name, value] pair`);
    }
    const [name, value] = pair;
    try {
      // has() validates the name only, so a later failure is the value's.
      merged.has(name);
    } catch {
      throw new Error(`execution.headers entry ${position} has an invalid header name`);
    }
    const lowerName = String(name).toLowerCase();
    try {
      // Replaced rather than appended, so a repeated Content-Type is never
      // sent as a combined "a, b" value that strict body parsers reject.
      if (lowerName === 'content-type') {
        merged.set(name, value);
      } else {
        merged.append(name, value);
      }
    } catch {
      throw new Error(`execution.headers has an invalid value for header "${lowerName}"`);
    }
  }
  if (!merged.has('content-type')) {
    merged.set('content-type', 'application/json');
  }
  return Object.fromEntries(merged);
};

/**
 * Execute a GraphQL operation against a remote HTTP endpoint. Transport
 * failures (network errors, timeouts, non-2xx statuses, non-JSON bodies) are
 * mapped to a GraphQL-shaped `{ errors }` result so they surface to the MCP
 * client as a regular `isError` tool result instead of an opaque exception.
 * Network errors, timeouts, HTTP 5xx and 429 are retried (queries only) when
 * `execution.retry` is configured. Retry k waits `backoffMs × k`. Two
 * opt-ins change that: `retry.retryAfter: true` waits at least the
 * Retry-After of a retried HTTP response (once, for the next retry) and ends
 * the retries with that response's failure when it asks for more than
 * `retry.maxRetryAfterMs`; `retry.jitter: true` adds a random wait of up to
 * half of `backoffMs × k`. `endpoint`, `headers` and `timeoutMs` are
 * read on every call (see {@link buildRemoteHeaders} and
 * {@link normalizeTimeoutMs}); setup may have left their checks to it.
 * The caller's `signal` cancels the fetch, the body reading and a retry
 * wait: the call then rejects with the abort reason, without retrying.
 * @param {string} query
 * @param {Object} variables
 * @param {{ endpoint: string, headers?: Object|Iterable, timeoutMs?: number|string,
 *   retry?: { attempts?: number, backoffMs?: number, retryAfter?: boolean,
 *   maxRetryAfterMs?: number, jitter?: boolean } }} execution
 * @param {{ signal?: AbortSignal, canRetry?: boolean }} [callOptions]
 * @returns {Promise<Object>} GraphQL response body (or synthesized errors)
 */
const executeRemote = async (query, variables, execution, { signal, canRetry } = {}) => {
  const retry = execution.retry || {};
  // Coerce retry knobs defensively: NaN/strings/negatives must not disable the
  // loop (returning undefined) or multiply attempts ('2' + 1 === '21').
  const extraAttempts = Number.isFinite(Number(retry.attempts)) && Number(retry.attempts) > 0
    ? Math.floor(Number(retry.attempts))
    : 0;
  const maxAttempts = canRetry ? extraAttempts + 1 : 1;
  const backoffMs = Number.isFinite(Number(retry.backoffMs)) && Number(retry.backoffMs) >= 0
    ? Number(retry.backoffMs)
    : 250;
  // Opt-ins: any value other than true keeps the 3.5.9 schedule.
  const honorRetryAfter = retry.retryAfter === true;
  const jitter = retry.jitter === true;
  // Unset, negative or non-numeric caps keep the default; Infinity means the timer limit.
  const retryAfterCap = honorRetryAfter && retry.maxRetryAfterMs != null ? Number(retry.maxRetryAfterMs) : Number.NaN;
  const maxRetryAfterMs = retryAfterCap >= 0
    ? Math.min(retryAfterCap, MAX_REMOTE_TIMEOUT_MS)
    : DEFAULT_MAX_RETRY_AFTER_MS;
  const timeoutMs = normalizeTimeoutMs(execution.timeoutMs);
  let lastFailure;
  // The wait the previous attempt's Retry-After asked for, when honored.
  let requested;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      const base = backoffMs * (attempt - 1);
      let delay = requested === undefined ? base : Math.max(base, requested);
      // A Retry-After applies to the next retry only.
      requested = undefined;
      if (jitter) {
        delay += Math.floor(Math.random() * (base / 2));
      }
      // Outside the try on purpose: a cancellation rejects like an aborted fetch.
      await sleep(delay, signal);
    }
    const { signal: requestSignal, release } = combineAbortSignals([
      signal,
      timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    ]);

    try {
      const response = await globalThis.fetch(execution.endpoint, {
        method: 'POST',
        headers: buildRemoteHeaders(execution.headers),
        body: JSON.stringify({ query, variables }),
        signal: requestSignal,
      });

      let body;
      try {
        body = await response.json();
      } catch (err) {
        // Reading the body is part of the request: aborts and broken streams
        // must retain cancellation/retry semantics, even after headers arrive.
        if ((requestSignal && requestSignal.aborted) || !(err instanceof SyntaxError)) {
          throw err;
        }
        if (response.ok) {
          return remoteTransportError('GraphQL endpoint returned a non-JSON response', 'MCP_REMOTE_INVALID_RESPONSE');
        }
      }

      if (!response.ok) {
        // Preserve real GraphQL errors from HTTP validation/coercion failures.
        lastFailure = isGraphQLResponse(body) ? body : remoteTransportError(
          `GraphQL endpoint responded with HTTP ${response.status}`,
          'MCP_REMOTE_HTTP_ERROR',
          { status: response.status },
        );
        if (response.status >= 500 || response.status === 429) {
          if (honorRetryAfter) {
            requested = retryAfterMs(response);
            // The server will not be ready within the cap: the retries end
            // with this failure instead of waiting.
            if (requested !== undefined && requested > maxRetryAfterMs) {
              return lastFailure;
            }
          }
          continue;
        }
        return lastFailure;
      }

      if (!isGraphQLResponse(body)) {
        return remoteTransportError('GraphQL endpoint returned an invalid GraphQL response payload', 'MCP_REMOTE_INVALID_RESPONSE');
      }
      return body;
    } catch (err) {
      if (signal && signal.aborted) {
        throw err;
      }
      // fetch cannot request an unusable endpoint (relative, unparsable,
      // non-http(s), or changed after setup to one with credentials), and its
      // TypeError quotes the URL, credentials included. Report the reason
      // instead; other TypeErrors, such as an application fetch's own
      // network failure, keep their message.
      const endpointProblem = err instanceof TypeError && quotesEndpoint(err.message, execution.endpoint)
        ? remoteEndpointProblem(execution.endpoint) || 'the endpoint URL could not be requested'
        : null;
      lastFailure = remoteTransportError(
        `GraphQL endpoint request failed: ${endpointProblem || (err && err.message ? err.message : err)}`,
        'MCP_REMOTE_REQUEST_FAILED',
      );
    } finally {
      release();
    }
  }
  return lastFailure;
};

/** Whether `object` has an own getter for `key`, which reading it would run. */
const hasOwnGetter = (object, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return Boolean(descriptor) && typeof descriptor.get === 'function';
};

/** Marks a setup check left to executeRemote, which reads the value per call. */
const CHECKED_PER_CALL = Symbol('checked per call');

/** Whether a fetch error message may quote `endpoint`: it names the URL, or the URL carries credentials. */
const quotesEndpoint = (message, endpoint) => {
  if (typeof message !== 'string') {
    return false;
  }
  const url = parseEndpoint(endpoint);
  if (url && (url.username || url.password)) {
    return true;
  }
  const texts = [typeof endpoint === 'string' ? endpoint : null, endpoint && endpoint.url, url && url.href];
  return texts.some((text) => typeof text === 'string' && text !== '' && message.includes(text));
};

/**
 * Read `execution[key]` for a setup check, or return CHECKED_PER_CALL. An
 * own getter is not run: it may compute the value per call, say from a token
 * that loads later. Other reads (a data property, an inherited getter, a
 * Proxy) run at setup; one that throws, typically because such a token is
 * not loaded yet, also leaves the check to each call.
 * @param {Object} execution
 * @param {string} key
 * @returns {*}
 */
const readForSetupCheck = (execution, key) => {
  try {
    return hasOwnGetter(execution, key) ? CHECKED_PER_CALL : execution[key];
  } catch {
    return CHECKED_PER_CALL;
  }
};

const resolveExecution = (execution) => {
  const resolved = execution ?? { mode: 'in-process' };
  if (typeof resolved !== 'object' || Array.isArray(resolved)) {
    throw new SimfinityError(`Invalid MCP execution config: expected an object, got ${Array.isArray(resolved) ? 'array' : typeof resolved}`, 'MCP_INVALID_EXECUTION_MODE', 500);
  }
  const mode = resolved.mode || 'in-process';
  if (mode === 'remote' && !resolved.endpoint) {
    throw new SimfinityError('execution.endpoint is required when execution.mode is "remote"', 'MCP_MISSING_ENDPOINT', 500);
  }
  if (mode !== 'remote' && mode !== 'in-process') {
    throw new SimfinityError(`Unknown MCP execution mode: ${mode}`, 'MCP_INVALID_EXECUTION_MODE', 500);
  }
  if (mode === 'remote') {
    // fetch rejects a URL with credentials on every call. Other endpoints
    // the default fetch rejects (relative, unparsable or non-http(s) ones)
    // may work with an application-provided fetch, so only executeRemote
    // reports them, without quoting the URL either.
    const url = parseEndpoint(resolved.endpoint);
    if (url && (url.username || url.password)) {
      throw invalidExecutionConfig(ENDPOINT_CREDENTIALS_PROBLEM);
    }
    // Fail at setup instead of on every call. executeRemote reads both again
    // on each call, so later changes apply; header values are not read here.
    const timeoutMs = readForSetupCheck(resolved, 'timeoutMs');
    if (timeoutMs !== CHECKED_PER_CALL) {
      normalizeTimeoutMs(timeoutMs);
    }
    const headers = readForSetupCheck(resolved, 'headers');
    let headersProblem = null;
    if (headers !== CHECKED_PER_CALL) {
      try {
        headersProblem = remoteHeadersProblem(headers);
      } catch {
        // A headers value whose own accessors throw, such as a Proxy over a
        // token that loads later, is checked on each call instead.
      }
    }
    if (headersProblem) {
      throw invalidExecutionConfig(headersProblem);
    }
  }
  return { mode, execution: resolved };
};

const isThenable = (value) => value !== null
  && (typeof value === 'object' || typeof value === 'function')
  && typeof value.then === 'function';

/** Short description of a configuration value for setup error messages. */
const describeValue = (value) => {
  if (Array.isArray(value)) {
    return 'an array';
  }
  if (isThenable(value)) {
    return 'a promise';
  }
  if (typeof value === 'function') {
    return value.name ? `function ${value.name}` : 'a function';
  }
  return value === null ? 'null' : typeof value;
};

// Envelop, Yoga, whatwg-node server and Apollo hooks that MCP does not run.
// Their presence marks an entry as a plausible shared plugin, which is warned
// about instead of rejected.
const IGNORED_PLUGIN_HOOK_RE = /^on[A-Z]/;
const IGNORED_PLUGIN_KEYS = new Set(['instrumentation', 'requestDidStart', 'serverWillStart']);
// No Envelop, Yoga or Apollo hook other than onSchemaChange starts with
// onSchema or is within this edit distance of it, so on an entry without
// onSchemaChange such a key is a misspelling that would leave resolvers unwrapped.
const SCHEMA_HOOK = 'onschemachange';
const MAX_SCHEMA_HOOK_TYPOS = 2;
const warnedSchemaPlugins = new WeakSet();

/**
 * Optimal string alignment distance: insertions, deletions, substitutions and
 * transpositions of adjacent characters each cost one edit.
 */
const editDistance = (a, b) => {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j += 1) {
    rows[0][j] = j;
  }
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
      }
    }
  }
  return rows[a.length][b.length];
};

/** A key that, ignoring letter case, starts with onSchema or is a near miss of onSchemaChange. */
const isMisspelledSchemaHook = (key) => {
  const lower = key.toLowerCase();
  return key !== 'onSchemaChange' && (lower.startsWith('onschema')
    || (Math.abs(lower.length - SCHEMA_HOOK.length) <= MAX_SCHEMA_HOOK_TYPOS
      && editDistance(lower, SCHEMA_HOOK) <= MAX_SCHEMA_HOOK_TYPOS));
};

/**
 * Own and inherited property descriptors by name; the nearest one wins
 * (class-based plugins keep hooks on the prototype). Reading descriptors
 * never runs a getter.
 */
const pluginDescriptors = (plugin) => {
  const descriptors = new Map();
  for (let proto = plugin; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key !== 'constructor' && !descriptors.has(key)) {
        descriptors.set(key, Object.getOwnPropertyDescriptor(proto, key));
      }
    }
  }
  return descriptors;
};

/** An accessor counts as a declared hook without being invoked. */
const isDeclaredHook = (descriptor) => Boolean(descriptor)
  && (typeof descriptor.get === 'function' || descriptor.value != null);

/** A method, or an accessor that may return one; the accessor is not invoked. */
const isFunctionOrAccessor = (descriptor) => Boolean(descriptor)
  && (typeof descriptor.get === 'function' || typeof descriptor.value === 'function');

const invalidSchemaPlugin = (message) => new SimfinityError(message, 'MCP_INVALID_SCHEMA_PLUGIN', 500);

/**
 * Validate every `schemaPlugins` entry before any hook runs, so an invalid
 * entry can never leave the schema partially wrapped. Falsy entries are
 * skipped (the `enabled && plugin` pattern Envelop tolerates). Entries with
 * other recognized plugin hooks but no `onSchemaChange` are warned about once
 * per plugin object; entries that look like no plugin at all, or that lack
 * `onSchemaChange` but declare a misspelling of it (a method or getter whose
 * name starts with `onSchema`, or is at most two edits away from
 * `onSchemaChange`, ignoring case), are rejected. Only `onSchemaChange` is
 * read; other properties, `then` included, are inspected through their
 * descriptors, so getters never run.
 * @param {Array<Object>|null|undefined} schemaPlugins
 * @returns {Array<Object>} plugins exposing an `onSchemaChange` hook
 */
const normalizeSchemaPlugins = (schemaPlugins) => {
  if (schemaPlugins == null) {
    return [];
  }
  if (!Array.isArray(schemaPlugins)) {
    throw invalidSchemaPlugin(`schemaPlugins must be an array of plugin objects, got ${describeValue(schemaPlugins)}`);
  }
  const installers = [];
  schemaPlugins.forEach((plugin, index) => {
    if (!plugin) {
      return;
    }
    if (typeof plugin === 'function') {
      throw invalidSchemaPlugin(`schemaPlugins[${index}] is ${describeValue(plugin)}, not a plugin object; call the plugin factory (e.g. createAuthPlugin(permissions)) and pass its result`);
    }
    if (typeof plugin !== 'object' || Array.isArray(plugin)) {
      throw invalidSchemaPlugin(`schemaPlugins[${index}] must be a plugin object, got ${describeValue(plugin)}`);
    }
    const descriptors = pluginDescriptors(plugin);
    // Checked through the descriptor, so a `then` getter is not invoked.
    if (isFunctionOrAccessor(descriptors.get('then'))) {
      throw invalidSchemaPlugin(`schemaPlugins[${index}] must be a plugin object, got a promise`);
    }
    if (plugin.onSchemaChange != null && typeof plugin.onSchemaChange !== 'function') {
      throw invalidSchemaPlugin(`schemaPlugins[${index}].onSchemaChange must be a function, got ${describeValue(plugin.onSchemaChange)}`);
    }
    const keys = [...descriptors.keys()];
    const hasSchemaHook = typeof plugin.onSchemaChange === 'function';
    // Next to a working onSchemaChange, onSchema* helpers leave nothing unwrapped.
    const misspelled = !hasSchemaHook && keys.find((key) => isMisspelledSchemaHook(key)
      && isFunctionOrAccessor(descriptors.get(key)));
    if (misspelled) {
      throw invalidSchemaPlugin(`schemaPlugins[${index}] declares ${misspelled}, which MCP does not recognize; did you mean onSchemaChange?`);
    }
    const ignored = keys.filter((key) => key !== 'onSchemaChange'
      && (IGNORED_PLUGIN_HOOK_RE.test(key) || IGNORED_PLUGIN_KEYS.has(key))
      && isDeclaredHook(descriptors.get(key)));
    if (hasSchemaHook) {
      installers.push(plugin);
    } else if (ignored.length === 0) {
      throw invalidSchemaPlugin(`schemaPlugins[${index}] has no onSchemaChange hook and no other plugin hooks (keys: ${keys.join(', ') || 'none'})`);
    }
    if (ignored.length && !warnedSchemaPlugins.has(plugin)) {
      warnedSchemaPlugins.add(plugin);
      const nested = ignored.includes('onPluginInit') ? ' Plugins it would register with addPlugin are not installed either.' : '';
      console.warn(`[simfinity-mcp] schemaPlugins[${index}]: MCP invokes only onSchemaChange and ignores ${ignored.join(', ')}.${nested} In-process tool calls run without that behavior.`);
    }
  });
  return installers;
};

/**
 * Apply Envelop-style schema plugins (e.g. simfinity's createAuthPlugin) to the
 * schema by invoking their `onSchemaChange` hooks. In a regular GraphQL server
 * Envelop fires these hooks at startup; standalone MCP servers execute with
 * graphql-js directly and would otherwise silently skip resolver-wrapping plugins such
 * as field-level auth. MCP executes the schema it was given, so `replaceSchema`
 * accepts only that same schema (a no-op, as in Envelop) and otherwise throws
 * MCP_UNSUPPORTED_SCHEMA_REPLACEMENT.
 * @param {import('graphql').GraphQLSchema} schema
 * @param {Array<Object>} schemaPlugins
 * @returns {Promise<void>|null} settles once asynchronous hooks finish; null
 *   when every hook completed synchronously
 */
const applySchemaPlugins = (schema, schemaPlugins) => {
  const installers = normalizeSchemaPlugins(schemaPlugins);
  const replaceSchema = (next) => {
    if (next !== schema) {
      throw new SimfinityError('schemaPlugins cannot replace the schema: MCP executes the schema passed to it. Wrap resolvers in place instead.', 'MCP_UNSUPPORTED_SCHEMA_REPLACEMENT', 500);
    }
  };
  const pending = [];
  try {
    for (const plugin of installers) {
      const result = plugin.onSchemaChange({ schema, replaceSchema });
      if (isThenable(result)) {
        pending.push(result);
      }
    }
  } catch (err) {
    // The synchronous failure is the setup error; earlier asynchronous hooks
    // must not surface later as unhandled rejections.
    pending.forEach((result) => { Promise.resolve(result).catch(() => {}); });
    throw err;
  }
  return pending.length ? Promise.all(pending).then(() => undefined) : null;
};

/**
 * Validate `toolMiddleware` at setup and snapshot it. A single function is a
 * one-element stack; anything else must be an array of functions.
 * @param {Function|Array<Function>|null|undefined} toolMiddleware
 * @returns {Array<Function>|null} a copy of the stack, or null when empty
 */
const normalizeToolMiddleware = (toolMiddleware) => {
  if (toolMiddleware == null) {
    return null;
  }
  const list = typeof toolMiddleware === 'function' ? [toolMiddleware] : toolMiddleware;
  if (!Array.isArray(list)) {
    throw new SimfinityError(`toolMiddleware must be a function or an array of functions, got ${describeValue(toolMiddleware)}`, 'MCP_INVALID_MIDDLEWARE', 500);
  }
  // An index loop visits holes in sparse arrays, which forEach would skip.
  for (let index = 0; index < list.length; index += 1) {
    if (typeof list[index] !== 'function') {
      const got = index in list ? describeValue(list[index]) : 'an empty array slot';
      throw new SimfinityError(`toolMiddleware[${index}] must be a function, got ${got}`, 'MCP_INVALID_MIDDLEWARE', 500);
    }
  }
  return list.length ? [...list] : null;
};

const invalidLimits = (message) => new SimfinityError(message, 'MCP_INVALID_LIMITS', 500);

const LIMIT_CAPS = ['maxPageSize', 'maxResultBytes'];

/** A cap value as shown in a setup error message. */
const describeCap = (value) => {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') {
    return `${value}n`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return typeof value === 'symbol' ? 'a symbol' : describeValue(value);
};

/**
 * Read one numeric cap. A falsy value (omitted, null, false, 0, '', NaN)
 * leaves the cap unset, as `cond && 100` does. Numbers, bigints and numeric
 * strings (e.g. from environment variables, 'Infinity' included) of at least
 * 1 are converted with Number(), as the comparison always coerced them. Any
 * other value either rejected every call (numbers below 1, true, blank
 * strings and strings that coerce to a number below 1) or silently applied
 * no cap (other strings, objects), so it is a configuration error.
 * @param {string} name cap name, for the error message
 * @param {*} value
 * @returns {number|undefined}
 */
const normalizeCap = (name, value) => {
  if (!value) {
    return undefined;
  }
  let number = Number.NaN;
  if (typeof value === 'number' || typeof value === 'bigint') {
    number = Number(value);
  } else if (typeof value === 'string' && value.trim() !== '') {
    number = Number(value);
  }
  if (number >= 1) {
    return number;
  }
  throw invalidLimits(`limits.${name} must be a number of at least 1, got ${describeCap(value)}; omit it, or pass 0, false or null, to disable the cap`);
};

/**
 * Normalize `limits`: falsy means no limits, and a falsy `defaultPagination`
 * means no default page. Throws MCP_INVALID_LIMITS for any other non-object
 * value and for invalid caps (see {@link normalizeCap}). Runs at setup and,
 * because callers may change their `limits` object later, on every call.
 * @param {*} limits
 * @returns {{ maxPageSize?: number, maxResultBytes?: number, defaultPagination?: Object }}
 */
const readLimits = (limits) => {
  if (!limits) {
    return {};
  }
  if (!isRecord(limits)) {
    throw invalidLimits(`limits must be an object such as { maxPageSize: 100 }, got ${describeValue(limits)}`);
  }
  const normalized = {};
  for (const name of LIMIT_CAPS) {
    const cap = normalizeCap(name, limits[name]);
    if (cap !== undefined) {
      normalized[name] = cap;
    }
  }
  const { defaultPagination } = limits;
  if (defaultPagination) {
    if (!isRecord(defaultPagination)) {
      throw invalidLimits(`limits.defaultPagination must be an object such as { page: 1, size: 20 }, got ${describeValue(defaultPagination)}`);
    }
    normalized.defaultPagination = defaultPagination;
  }
  return normalized;
};

/**
 * Validate `limits` at setup, so a configuration that would make calls fail
 * (or blame the caller for a page size the server itself injected) is
 * reported before serving. A NaN cap (typically Number() of an unset
 * environment variable) applies no cap, as before, with one warning per
 * setup. The tools' pagination types are checked by
 * {@link validateDefaultPagination} once the tools are built.
 * @param {*} limits
 * @returns {{ maxPageSize?: number, maxResultBytes?: number, defaultPagination?: Object }}
 */
const normalizeLimits = (limits) => {
  const normalized = readLimits(limits);
  const notANumber = limits ? LIMIT_CAPS.filter((name) => Number.isNaN(limits[name])) : [];
  if (notANumber.length) {
    const names = notANumber.map((name) => `limits.${name}`).join(' and ');
    console.warn(`[simfinity-mcp] ${names} ${notANumber.length > 1 ? 'are' : 'is'} NaN, so no cap is applied. Pass a number of at least 1, or omit it.`);
  }
  const { defaultPagination, maxPageSize } = normalized;
  if (defaultPagination && maxPageSize !== undefined
      && typeof defaultPagination.size === 'number' && defaultPagination.size > maxPageSize) {
    throw invalidLimits(`limits.defaultPagination.size (${defaultPagination.size}) exceeds limits.maxPageSize (${maxPageSize})`);
  }
  return normalized;
};

/**
 * Check the default page against the `pagination` argument type of every
 * published tool (once per distinct type), so a default GraphQL would reject
 * (a missing `page`, a fractional or string size, an unknown key) fails setup
 * instead of every call that sends no pagination. For Simfinity's
 * QLPagination, page and size must also be positive integers, as core's
 * pagination requires; core's own page-size cap (configureQueryLimits) can
 * change at runtime and is unknown in remote mode, so it is not checked.
 * @param {{ defaultPagination?: Object }} limits from {@link normalizeLimits}
 * @param {Object} toolIndex from {@link buildToolDefinitions}
 */
const validateDefaultPagination = ({ defaultPagination }, toolIndex) => {
  if (!defaultPagination) {
    return;
  }
  const checked = new Set();
  for (const [toolName, entry] of Object.entries(toolIndex)) {
    const type = entry.paginationType;
    if (!type || checked.has(type)) {
      continue;
    }
    checked.add(type);
    const problems = [];
    const coerced = coerceInputValue(defaultPagination, type, (path, invalid, error) => {
      problems.push(error.message);
    });
    const named = getNamedType(type).name;
    if (!problems.length && named === 'QLPagination'
        && !['page', 'size'].every((key) => Number.isSafeInteger(coerced[key]) && coerced[key] >= 1)) {
      problems.push('QLPagination requires page and size to be positive integers.');
    }
    if (problems.length) {
      throw invalidLimits(`limits.defaultPagination is not a valid ${named} for the pagination argument of tool "${toolName}": ${problems.join(' ')}`);
    }
  }
};

/**
 * Compose `toolMiddleware` functions (koa-style `(call, next)`) around the
 * terminal executor. Middleware may inspect/modify `call.args`, short-circuit
 * by returning a result without calling `next()`, or throw. A synchronous
 * throw rejects the previous middleware's `next()` promise, as an async one
 * does, so outer `.catch`/`.finally` boundaries see it. Every `next()`
 * promise is marked handled: a middleware may await other work before
 * awaiting it, and a rejection of one that no middleware awaits or returns
 * is dropped instead of becoming an unhandled rejection.
 * @param {Array<Function>|null} middlewares stack from {@link normalizeToolMiddleware}
 * @param {Function} terminal `(call) => Promise<CallToolResult>`
 * @returns {Function}
 */
const composeToolMiddleware = (middlewares, terminal) => {
  if (!middlewares || middlewares.length === 0) {
    return terminal;
  }
  return async (call) => {
    let lastIndex = -1;
    const dispatch = (i) => {
      let pending;
      if (i <= lastIndex) {
        pending = Promise.reject(new SimfinityError('next() called multiple times in MCP tool middleware', 'MCP_MIDDLEWARE_ERROR', 500));
      } else {
        lastIndex = i;
        try {
          pending = Promise.resolve(i === middlewares.length
            ? terminal(call)
            : middlewares[i](call, () => dispatch(i + 1)));
        } catch (err) {
          pending = Promise.reject(err);
        }
      }
      // Callers that await or chain the promise still see the rejection.
      pending.catch(() => {});
      return pending;
    };
    const result = await dispatch(0);
    if (result === undefined) {
      // A middleware performed side effects but neither returned a result nor
      // called next(); fail loudly at the source instead of sending an
      // undefined CallToolResult over the wire.
      throw new SimfinityError(`MCP tool middleware for "${call.name}" returned undefined (did it forget to return next()?)`, 'MCP_MIDDLEWARE_ERROR', 500);
    }
    return result;
  };
};

const prettyJSON = (value) => JSON.stringify(value, null, 2);
const compactJSON = (value) => JSON.stringify(value);

/**
 * The serializer of the text content block for a `textFormat` option: unset
 * (undefined or null) or 'pretty' is the 3.5.9 pretty-printed JSON, 'compact'
 * is JSON without whitespace. Any other value throws MCP_INVALID_OPTIONS.
 * @param {*} textFormat
 * @returns {(value: *) => string}
 */
const normalizeTextFormat = (textFormat) => {
  if (textFormat == null || textFormat === 'pretty') {
    return prettyJSON;
  }
  if (textFormat === 'compact') {
    return compactJSON;
  }
  throw new SimfinityError(`textFormat must be 'pretty' or 'compact', got ${describeCap(textFormat)}`, 'MCP_INVALID_OPTIONS', 500);
};

const limitErrorResult = (stringify, message, code, extensions) => ({
  content: [{
    type: 'text',
    text: stringify({ errors: [{ message, extensions: { code, ...extensions } }] }),
  }],
  isError: true,
});

/**
 * The declared argument an unknown key most likely meant, or undefined. A
 * case-insensitive match always counts. Otherwise the edit distance may be 1
 * when either name has 4 characters or fewer and 2 for longer names, so short
 * keys such as AND or q are not mapped to unrelated short names; `id` is
 * suggested only on a case-insensitive match, since a wrong guess there
 * steers the agent to put an unrelated value into the record id.
 * @param {string} key
 * @param {Array<string>} names declared argument names
 * @returns {string|undefined}
 */
const suggestArgument = (key, names) => {
  const lower = key.toLowerCase();
  const exact = names.find((name) => name.toLowerCase() === lower);
  if (exact !== undefined) {
    return exact;
  }
  let best;
  let bestDistance = Infinity;
  for (const name of names) {
    const limit = Math.min(key.length, name.length) <= 4 ? 1 : 2;
    // The distance is at least the length difference; skipping those keeps
    // arbitrarily long keys cheap.
    if (name === 'id' || Math.abs(key.length - name.length) > limit) {
      continue;
    }
    const distance = editDistance(lower, name.toLowerCase());
    if (distance <= limit && distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
};

/**
 * Agent-facing text for undeclared top-level arguments the caller sent.
 * @param {string} toolName
 * @param {Array<string>} unknown
 * @param {Set<string>} argNames declared argument names
 * @returns {string}
 */
const unknownArgumentsMessage = (toolName, unknown, argNames) => {
  const valid = [...argNames];
  const hints = [];
  for (const key of unknown) {
    const near = suggestArgument(key, valid);
    if (near !== undefined) {
      hints.push(`"${near}" instead of "${key}"`);
    }
  }
  const names = unknown.map((key) => `"${key}"`).join(', ');
  const plural = unknown.length > 1 ? 's' : '';
  return `Unknown argument${plural} ${names} for tool "${toolName}".`
    + `${hints.length ? ` Did you mean ${hints.join(', ')}?` : ''}`
    + `${valid.length ? ` Valid arguments: ${valid.join(', ')}.` : ' The tool takes no arguments.'}`
    + ' The tool was not executed.';
};

/**
 * Root-value key under which simfinity-core's generated find resolver looks
 * for a count sink (see reportCount in packages/core/src/runtime.js). When the
 * root value carries a function there, the resolver hands it the pagination
 * count instead of writing `context.count`. Core does not export the symbol;
 * Symbol.for gives both packages the same key.
 */
const COUNT_SINK = Symbol.for('simfinity.countSink');

/**
 * Key for a value MCP adds next to the GraphQL root field in a result. The
 * root field is the only other key, so it collides only when it has exactly
 * that name; the fallback starts with `__`, which GraphQL reserves for
 * introspection, so no root field can have it.
 */
const resultKey = (fieldName, name) => (fieldName === name ? `__${name}` : name);

const countPropertySchema = (countKey) => ({
  type: 'integer',
  minimum: 0,
  description: `Total number of matching records across all pages. Present when pagination.count is true and the server computed a total.${countKey === 'totalCount' ? '' : ' Named __totalCount because the list field itself is named totalCount.'}`,
});

const truncationPropertySchema = () => ({
  type: 'object',
  description: 'Present instead of the full result when an applied mutation returned more than maxResultBytes: only the id (or ids) of the root value is kept next to this notice, when they fit within maxResultBytes.',
  properties: {
    applied: { type: 'boolean' },
    message: { type: 'string' },
    resultBytes: { type: 'integer' },
    maxResultBytes: { type: 'integer' },
  },
  required: ['applied', 'message', 'resultBytes', 'maxResultBytes'],
});

/** Reduce a mutation's root value to `{ id }` (or `[{ id }, ...]`), or undefined when an id is missing. */
const compactMutationValue = (value) => {
  const pick = (item) => (item !== null && typeof item === 'object'
    && (typeof item.id === 'string' || typeof item.id === 'number') ? { id: item.id } : undefined);
  if (Array.isArray(value)) {
    const ids = value.map(pick);
    return ids.length > 0 && ids.every(Boolean) ? ids : undefined;
  }
  return pick(value);
};

const FIRST_ERROR_MAX_LENGTH = 300;

const truncateErrorMessage = (message) => {
  if (message.length <= FIRST_ERROR_MAX_LENGTH) {
    return message;
  }
  let head = message.slice(0, FIRST_ERROR_MAX_LENGTH);
  if (/[\uD800-\uDBFF]$/.test(head)) {
    // Do not cut a surrogate pair in half.
    head = head.slice(0, -1);
  }
  return `${head}…`;
};

/**
 * Text of the notice for an oversized mutation result. It never invites a
 * blind retry, never contradicts an idempotentHint, says whether calling the
 * tool again could repeat the change, and never sends the agent to read a
 * record the tool deleted.
 * @param {Object} params
 * @param {string} params.name tool name
 * @param {string} params.op operation kind from classifyOperation
 * @param {boolean} params.idempotent whether the tool advertises idempotentHint
 * @param {true|'unknown'} params.applied `'unknown'` when errors left no root
 *   value (no ids to report then)
 * @param {boolean} params.withErrors whether the result carried GraphQL errors
 * @param {boolean} params.withFirstError whether extensions.firstError is set
 * @param {string} params.sizes "(N bytes) exceeds maxResultBytes (M)"
 * @param {string} params.idNote what happened to the root ids
 * @returns {string}
 */
const oversizedMutationMessage = ({
  name, op, idempotent, applied, withErrors, withFirstError, sizes, idNote,
}) => {
  if (applied === 'unknown') {
    let repeat;
    if (idempotent) {
      repeat = `Calling ${name} again with the same arguments would not repeat a change that was already applied.`;
    } else if (op === 'add') {
      repeat = `If it was applied, calling ${name} again would create another record.`;
    } else {
      repeat = `If it was applied, calling ${name} again could repeat the change.`;
    }
    const check = op === 'delete'
      ? 'Check whether the record still exists with a query tool before calling it again.'
      : 'Check the current state with a query tool before calling it again.';
    const firstError = withFirstError ? ' (extensions.firstError holds the start of the first error)' : '';
    return `${name} returned errors; the error result ${sizes} and was omitted${firstError}. It may have been applied, fully or in part. ${repeat} ${check}`;
  }
  const done = { add: ' (the record was created)', update: ' (the record was updated)', delete: ' (the record was deleted)' }[op] || '';
  const omitted = withErrors
    ? `, but parts of its result failed; the result with errors ${sizes} and was omitted${idNote}.`
    : `. Its full result ${sizes} and was omitted${idNote}.`;
  let repeat;
  if (idempotent) {
    repeat = `Calling ${name} again with the same arguments would not repeat the change, so there is no need to call it again`;
  } else if (op === 'add') {
    repeat = `Calling ${name} again would create another record; do not call ${name} again for this change`;
  } else {
    repeat = `Calling ${name} again could repeat the change; do not call ${name} again for this change`;
  }
  let read;
  if (op === 'delete') {
    read = 'the record no longer exists, so there is nothing to read back';
  } else if (op === 'add' || op === 'update') {
    read = 'use a query tool to read the record if you need its other fields';
  } else {
    read = 'use a query tool to read the current state if you need it';
  }
  return `${name} was applied${done}${omitted} ${repeat}; ${read}.`;
};

/**
 * Result for a mutation whose payload exceeds maxResultBytes. The write has
 * already run, so a success stays a success (the root id or ids next to a
 * notice) and an error says whether the root field returned. The notice is a
 * limit diagnostic, so the cap does not apply to it; the root id, or the id
 * list, is kept only when it fits within the cap.
 * @param {Object} params
 * @param {Object} params.entry toolIndex entry of the mutation tool
 * @param {string} params.name tool name
 * @param {Object} params.result GraphQL execution result
 * @param {boolean} params.isError whether the result carried GraphQL errors
 * @param {number} params.bytes size of the omitted result text
 * @param {number} params.maxResultBytes the configured cap, possibly
 *   fractional; the notice reports it rounded down
 * @param {(value: *) => string} params.stringify serializer of the text
 *   content block, from {@link normalizeTextFormat}
 * @returns {Object} CallToolResult
 */
const oversizedMutationResult = ({
  entry, name, result, isError, bytes, maxResultBytes, stringify,
}) => {
  const root = result.data !== null && typeof result.data === 'object' ? result.data[entry.fieldName] : undefined;
  // The outputSchema declares an integer, and a fractional cap is accepted.
  // Byte counts are integers, so `bytes > cap` and `bytes > floor(cap)` agree.
  const cap = Math.floor(maxResultBytes);
  let compact = compactMutationValue(root);
  let idNote = '';
  if (compact !== undefined) {
    if (Buffer.byteLength(JSON.stringify(compact), 'utf8') > cap) {
      idNote = Array.isArray(compact)
        ? '; its ids alone exceed maxResultBytes and were omitted too'
        : '; its id alone exceeds maxResultBytes and was omitted too';
      compact = undefined;
    } else {
      idNote = Array.isArray(compact) ? '; only the ids are returned' : '; only the id is returned';
    }
  }
  // Without errors the root field returned; with errors only a non-null root
  // shows that it did. A null root proves nothing: NonNull bubbling from a
  // nested field can null the root of a committed write.
  const applied = !isError || root != null ? true : 'unknown';
  const first = isError && Array.isArray(result.errors) ? result.errors[0] : undefined;
  const firstError = first && typeof first.message === 'string' ? truncateErrorMessage(first.message) : undefined;
  const message = oversizedMutationMessage({
    name,
    op: entry.op,
    idempotent: entry.idempotent,
    applied,
    withErrors: isError,
    withFirstError: firstError !== undefined,
    sizes: `(${bytes} bytes) exceeds maxResultBytes (${cap})`,
    idNote,
  });
  if (!isError) {
    const structured = {};
    if (compact !== undefined) {
      structured[entry.fieldName] = compact;
    }
    structured[entry.truncationKey] = {
      applied: true, message, resultBytes: bytes, maxResultBytes: cap,
    };
    return {
      content: [{ type: 'text', text: stringify(structured) }],
      structuredContent: structured,
      isError: false,
      _meta: { truncated: true },
    };
  }
  const extensions = { code: 'MCP_RESULT_TOO_LARGE', applied };
  if (firstError !== undefined) {
    extensions.firstError = firstError;
  }
  const payload = { errors: [{ message, extensions }] };
  if (compact !== undefined) {
    payload.data = { [entry.fieldName]: compact };
  }
  return { content: [{ type: 'text', text: stringify(payload) }], isError: true };
};

/**
 * Parse and validate a tool's operation, as graphql() does on every call.
 * @param {import('graphql').GraphQLSchema} schema a valid schema
 * @param {string} source
 * @returns {{ document: import('graphql').DocumentNode }|{ errors: Array }}
 */
const prepareOperation = (schema, source) => {
  let document;
  try {
    document = parse(source);
  } catch (syntaxError) {
    return { errors: [syntaxError] };
  }
  const errors = validate(schema, document);
  return errors.length > 0 ? { errors } : { document };
};

/**
 * Build the `callTool` executor bound to a given execution mode and context.
 * @param {Object} params
 * @param {import('graphql').GraphQLSchema} params.schema
 * @param {Object} params.toolIndex operation index from {@link buildToolDefinitions}
 * @param {'in-process'|'remote'} params.mode
 * @param {Object} params.execution
 * @param {Object|Function} params.context GraphQL context value or factory
 * @param {Object} [params.limits] the caller's result/pagination guardrails,
 *   validated at setup by {@link normalizeLimits} and read again on every
 *   call, so later changes to the object apply
 * @param {Array<Function>|null} [params.toolMiddleware] stack from
 *   {@link normalizeToolMiddleware}
 * @param {Promise<void>|null} [params.ready] pending schemaPlugins
 *   installation that every call awaits before running
 * @param {(value: *) => string} [params.stringify] serializer of the text
 *   content block, from {@link normalizeTextFormat}
 * @returns {Function} async `(name, args, extra) => CallToolResult`
 */
const createCallTool = ({
  schema, toolIndex, mode, execution, context, limits: callerLimits, toolMiddleware, ready,
  stringify = prettyJSON,
}) => {
  // Argument keys with a defined value that the caller sent, per call object
  // (middleware receives and hands the terminal the same object).
  const callerKeys = new WeakMap();

  const terminal = async (call) => {
    const entry = toolIndex[call.name];
    if (!entry) {
      throw new SimfinityError(`Unknown MCP tool: ${call.name}`, 'MCP_TOOL_NOT_FOUND', 404);
    }
    if (call.extra && call.extra.signal && call.extra.signal.aborted) {
      throw new SimfinityError(`MCP tool call cancelled: ${call.name}`, 'MCP_CALL_CANCELLED', 499);
    }
    const limits = readLimits(callerLimits);

    let args = call.args || {};
    // Only keys the caller sent are rejected: keys that middleware injected
    // (an owner filter added to every tool, say) pass through as before, and
    // a caller key that middleware consumed (deleted) is gone by now. Own
    // presence, as GraphQL coerces variables: once deleted, a key named like
    // an Object.prototype member (constructor, __proto__) must not count.
    const sent = callerKeys.get(call) || [];
    const unknown = typeof args === 'object'
      ? sent.filter((key) => !entry.argNames.has(key) && Object.hasOwn(args, key) && args[key] !== undefined)
      : [];
    if (unknown.length) {
      return limitErrorResult(stringify, unknownArgumentsMessage(call.name, unknown, entry.argNames), 'MCP_UNKNOWN_ARGUMENT');
    }
    if (entry.hasPagination) {
      if (limits.defaultPagination && args.pagination == null) {
        args = { ...args, pagination: { ...limits.defaultPagination } };
      }
      const size = args.pagination ? args.pagination.size : undefined;
      if (limits.maxPageSize && typeof size === 'number' && size > limits.maxPageSize) {
        return limitErrorResult(
          stringify,
          `pagination.size ${size} exceeds the maximum allowed page size ${limits.maxPageSize}. Request a smaller page.`,
          'MCP_PAGE_SIZE_EXCEEDED',
        );
      }
    }

    let result;
    // Object whose own `count` receives this call's count, when one was requested.
    let countHolder = null;
    if (mode === 'remote') {
      result = await executeRemote(entry.operation, args, execution, {
        signal: call.extra ? call.extra.signal : undefined,
        canRetry: entry.kind === 'query',
      });
    } else {
      let contextValue = typeof context === 'function' ? await context(call.extra) : context;
      let rootValue;
      const wantsCount = entry.op === 'list' && !!(args.pagination && args.pagination.count === true);
      if (entry.countSink) {
        // Generated find resolvers report the count to a per-call root-value
        // sink, so they get the caller's context unchanged. The sink is
        // installed on every call, counted or not, so resolvers, wrappers and
        // auth rules see the same root value whatever the agent sends.
        const holder = {};
        rootValue = Object.create(null);
        rootValue[COUNT_SINK] = (count) => { holder.count = count; };
        if (wantsCount) {
          countHolder = holder;
        }
      } else if (wantsCount && contextValue !== null && typeof contextValue === 'object') {
        // Other list resolvers (custom ones, or find resolvers of a core
        // without the countSink marker) write context.count. A private layer
        // per call keeps concurrent calls on a shared context from racing and
        // stale counts from surfacing on calls that never write one.
        contextValue = Object.create(contextValue);
        countHolder = contextValue;
      }
      if (call.extra && call.extra.signal && call.extra.signal.aborted) {
        throw new SimfinityError(`MCP tool call cancelled: ${call.name}`, 'MCP_CALL_CANCELLED', 499);
      }
      // graphql()'s steps, in its order, except that the tool's constant
      // operation is parsed and validated once instead of on every call. The
      // schema is still validated per call (graphql-js caches that on the
      // schema). The prepared operation lives on the tool's entry, which the
      // per-request callTools of the HTTP handler share; the first call runs
      // after `ready`, once schemaPlugins have wrapped the resolvers.
      const schemaErrors = validateSchema(schema);
      if (schemaErrors.length > 0) {
        result = { errors: schemaErrors };
      } else {
        entry.prepared ??= prepareOperation(schema, entry.operation);
        result = entry.prepared.errors
          ? { errors: [...entry.prepared.errors] }
          : await execute({
            schema,
            document: entry.prepared.document,
            variableValues: args,
            contextValue,
            rootValue,
          });
      }
    }

    const isError = !!(result.errors && result.errors.length);
    const count = mode === 'remote'
      ? (result.extensions && typeof result.extensions.count === 'number' ? result.extensions.count : undefined)
      // Own-property check: only a count written DURING this call counts.
      : (countHolder && Object.hasOwn(countHolder, 'count') && typeof countHolder.count === 'number' ? countHolder.count : undefined);
    // Hosts give the model structuredContent or the text and keep _meta for
    // client code, so a usable total is also placed next to the data.
    const totalCount = entry.countKey && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
    let data = result.data;
    if (!isError && data !== null && typeof data === 'object' && totalCount !== undefined) {
      data = { ...data, [entry.countKey]: totalCount };
    }
    const payload = isError ? { errors: result.errors } : data;
    if (isError && result.data != null) {
      // Keep partial results visible, subject to the same result-size cap.
      payload.data = result.data;
    }
    const text = stringify(payload);
    if (limits.maxResultBytes) {
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > limits.maxResultBytes) {
        if (entry.kind === 'mutation') {
          return oversizedMutationResult({
            entry, name: call.name, result, isError, bytes, maxResultBytes: limits.maxResultBytes, stringify,
          });
        }
        // Whole bytes, as in the mutation notice: a fractional cap allows
        // only results up to its integer part.
        return limitErrorResult(
          stringify,
          `Result of ${bytes} bytes exceeds maxResultBytes (${Math.floor(limits.maxResultBytes)}). Narrow the query, lower selectionDepth or paginate.`,
          'MCP_RESULT_TOO_LARGE',
          // The total tells the agent how far to paginate.
          totalCount !== undefined ? { totalCount } : undefined,
        );
      }
    }

    if (isError) {
      return { content: [{ type: 'text', text }], isError: true };
    }

    const response = {
      content: [{ type: 'text', text }],
      isError: false,
    };
    if (data != null) {
      response.structuredContent = data;
    }
    if (count !== undefined) {
      response._meta = { count };
    }
    return response;
  };

  const run = composeToolMiddleware(toolMiddleware, terminal);

  return async (name, args = {}, extra) => {
    const entry = toolIndex[name];
    if (!entry) {
      throw new SimfinityError(`Unknown MCP tool: ${name}`, 'MCP_TOOL_NOT_FOUND', 404);
    }
    if (ready) {
      await ready;
    }
    const call = {
      name, args, extra, kind: entry.kind, operation: entry.operation,
    };
    callerKeys.set(call, args !== null && typeof args === 'object'
      ? Object.keys(args).filter((key) => args[key] !== undefined)
      : []);
    return run(call);
  };
};

/**
 * The virtual fields that get their own read tool, in schema order: on the
 * type of every by-ID query (a query classified 'single' whose only argument
 * is `id`, as core generates for each entity type), each virtual field with
 * a required argument that has no default, unless its `mcp` option is false.
 * Agents read other virtual fields through the tools that select them (see
 * {@link isSelectable}); those of embedded and no-endpoint types have no
 * by-ID query, so they get no tool.
 * @param {import('graphql').GraphQLObjectType|null|undefined} queryType
 * @returns {Array<{ byIdName: string, byIdField: import('graphql').GraphQLField,
 *   entityType: import('graphql').GraphQLObjectType, fieldName: string,
 *   field: import('graphql').GraphQLField }>}
 */
const virtualFieldTargets = (queryType) => {
  const targets = [];
  if (!queryType) {
    return targets;
  }
  for (const [byIdName, byIdField] of Object.entries(queryType.getFields())) {
    const entityType = getNamedType(byIdField.type);
    if (!(entityType instanceof GraphQLObjectType)
        || byIdField.args.length !== 1 || byIdField.args[0].name !== 'id'
        || classifyOperation('query', byIdName, byIdField) !== 'single') {
      continue;
    }
    for (const [fieldName, field] of Object.entries(entityType.getFields())) {
      const options = virtualFieldOptions(field);
      if (options && options.mcp !== false && hasRequiredArgs(field)) {
        targets.push({
          byIdName, byIdField, entityType, fieldName, field,
        });
      }
    }
  }
  return targets;
};

/**
 * Build the context-independent tool definitions and the operation index from a
 * Simfinity-generated GraphQLSchema: one tool per root field, then one per
 * {@link virtualFieldTargets} entry. Shared by {@link generateMCPTools} and the
 * transport factories so the (potentially expensive) schema traversal happens
 * once, while execution context can be bound per request.
 * @param {import('graphql').GraphQLSchema} schema
 * @param {Object} [options]
 * @param {{ maxResultBytes?: number }} [limits] from {@link normalizeLimits}
 * @returns {{ tools: Array, toolIndex: Object }}
 */
const buildToolDefinitions = (schema, options = {}, limits = {}) => {
  if (!schema || typeof schema.getQueryType !== 'function') {
    throw new SimfinityError('A valid GraphQLSchema is required to generate MCP tools', 'MCP_INVALID_SCHEMA', 500);
  }

  // `includeId` (options and toolOverrides) is accepted and ignored: every
  // scalar/enum `id` without required arguments is always selected, which is
  // all its fallback could ever add.
  const {
    selectionDepth = 1,
    toolNamePrefix = '',
    toolOverrides = {},
  } = options;
  const { maxResultBytes } = limits;
  const include = toArray(options.include);
  const exclude = toArray(options.exclude);
  const includeTypes = toArray(options.includeTypes);
  const excludeTypes = toArray(options.excludeTypes);

  if (toolNamePrefix && !/^[a-zA-Z0-9_-]+$/.test(toolNamePrefix)) {
    throw new SimfinityError(`Invalid toolNamePrefix "${toolNamePrefix}": only letters, digits, underscore and hyphen are allowed`, 'MCP_INVALID_TOOL_NAME', 500);
  }

  const nestedCollections = normalizeNestedCollections(options.nestedCollections, 'nestedCollections');
  // Every override is checked, published or not, so a misspelled tool key
  // or an excluded tool does not hide an invalid value.
  if (toolOverrides !== null && typeof toolOverrides === 'object') {
    for (const [key, override] of Object.entries(toolOverrides)) {
      if (override != null) {
        normalizeNestedCollections(override.nestedCollections, `toolOverrides.${key}.nestedCollections`);
      }
    }
  }
  // One $defs registry for every tool of this run (see createDefRegistry).
  const defRegistry = createDefRegistry();

  const queryType = schema.getQueryType();

  const resolveEntityType = (op, fieldName, field) => {
    if (op === 'aggregate' && queryType) {
      const base = fieldName.replace(/_aggregate$/, '');
      const sibling = queryType.getFields()[base];
      if (sibling) {
        const named = getNamedType(sibling.type);
        return named instanceof GraphQLObjectType ? named : null;
      }
      return null;
    }
    const named = getNamedType(field.type);
    return named instanceof GraphQLObjectType ? named : null;
  };

  const tools = [];
  const toolIndex = Object.create(null);

  const addToolsFromType = (rootType, kind) => {
    if (!rootType) {
      return;
    }
    for (const [fieldName, field] of Object.entries(rootType.getFields())) {
      const toolName = `${toolNamePrefix}${fieldName}`;
      const op = classifyOperation(kind, fieldName, field);
      const entityType = resolveEntityType(op, fieldName, field);
      if (!isIncluded({
        names: [fieldName, toolName],
        kind,
        entityName: entityType ? entityType.name : null,
        include,
        exclude,
        includeTypes,
        excludeTypes,
      })) {
        continue;
      }
      if (!TOOL_NAME_RE.test(toolName)) {
        throw new SimfinityError(`Generated MCP tool name "${toolName}" is invalid (allowed: letters, digits, underscore, hyphen; max 128 chars)`, 'MCP_INVALID_TOOL_NAME', 500);
      }
      if (toolIndex[toolName]) {
        console.warn(`[simfinity-mcp] Duplicate tool name "${toolName}": ${kind} field "${fieldName}" collides with an existing ${toolIndex[toolName].kind} tool and is skipped — calls to "${toolName}" execute the ${toolIndex[toolName].kind}. (Before 2.7.0 both were listed and the ${kind} silently won.) Rename one of the GraphQL fields or use include/exclude to disambiguate.`);
        continue;
      }

      const override = toolOverrides[toolName] || toolOverrides[fieldName] || {};
      const depth = override.selectionDepth ?? selectionDepth;
      // The tool's own value wins; an explicit selection ignores both.
      const collections = override.nestedCollections == null
        ? nestedCollections
        : normalizeNestedCollections(override.nestedCollections, `toolOverrides.${toolName}.nestedCollections`);
      const title = override.title || buildToolTitle(op, fieldName, entityType);
      const description = override.description || buildToolDescription(op, fieldName, field, entityType);
      const annotations = { ...buildAnnotations(op, title, field), ...(override.annotations || {}) };
      const virtuals = virtualFieldsFor(field.type);
      const selection = override.selection
        ? normalizeSelection(override.selection)
        : buildSelectionSet(field.type, depth, collections, virtuals);

      const tool = {
        name: toolName,
        title,
        description,
        inputSchema: argsToJSONSchema(field, defRegistry),
        annotations,
        kind,
      };
      const hasPagination = hasArg(field, 'pagination');
      // Keys MCP adds next to the root field: the total of a counted list and
      // the notice that replaces an oversized mutation result.
      const countKey = op === 'list' && hasPagination ? resultKey(fieldName, 'totalCount') : undefined;
      const truncationKey = kind === 'mutation' ? resultKey(fieldName, 'truncated') : undefined;
      // An explicit selection override makes the mirrored output schema
      // unreliable, so it is omitted rather than published wrong.
      if (!override.selection) {
        tool.outputSchema = buildOutputSchema(fieldName, field, depth, collections, virtuals);
        if (countKey) {
          tool.outputSchema.properties[countKey] = countPropertySchema(countKey);
        }
        if (truncationKey && maxResultBytes) {
          tool.outputSchema.properties[truncationKey] = truncationPropertySchema();
        }
      }
      tools.push(tool);
      const query = field.extensions && field.extensions.simfinityQuery;
      toolIndex[toolName] = {
        operation: buildOperation(kind, fieldName, field, selection),
        kind,
        op,
        fieldName,
        hasPagination,
        // Type the default page is validated against at setup.
        paginationType: hasPagination ? field.args.find((arg) => arg.name === 'pagination').type : undefined,
        // Declared arguments; any other key the caller sends is rejected.
        argNames: new Set((field.args || []).map((arg) => arg.name)),
        countKey,
        truncationKey,
        idempotent: annotations.idempotentHint === true,
        // Generated find fields of a core that reports counts to a root-value
        // sink (see COUNT_SINK) advertise it with this marker.
        countSink: op === 'list' && !!query && query.operation === 'find' && query.countSink === true,
      };
    }
  };

  /**
   * Add a read tool named `<byIdQuery>_<field>` for each of
   * {@link virtualFieldTargets}. They come after every root field's tool, so
   * a name collision skips the virtual field tool, never a root field's.
   */
  const buildVirtualFieldTools = () => {
    for (const target of virtualFieldTargets(queryType)) {
      const { entityType, fieldName, field } = target;
      const rawName = `${target.byIdName}_${fieldName}`;
      const toolName = `${toolNamePrefix}${rawName}`;
      if (!isIncluded({
        names: [rawName, toolName],
        kind: 'query',
        entityName: entityType.name,
        include,
        exclude,
        includeTypes,
        excludeTypes,
      })) {
        continue;
      }
      if (!TOOL_NAME_RE.test(toolName)) {
        throw new SimfinityError(`Generated MCP tool name "${toolName}" is invalid (allowed: letters, digits, underscore, hyphen; max 128 chars)`, 'MCP_INVALID_TOOL_NAME', 500);
      }
      if (toolIndex[toolName]) {
        console.warn(`[simfinity-mcp] Duplicate tool name "${toolName}": the tool of virtual field "${entityType.name}.${fieldName}" collides with an existing ${toolIndex[toolName].kind} tool and is skipped — calls to "${toolName}" execute that ${toolIndex[toolName].kind}. Rename one of the fields, set extensions.virtual.mcp to false or use include/exclude to disambiguate.`);
        continue;
      }
      // Only a tool that is published takes the record's id, so a skipped one cannot clash with it.
      if (field.args.some((arg) => arg.name === 'id')) {
        throw new SimfinityError(`The virtual field ${entityType.name}.${fieldName} has an argument named id, which its MCP tool "${toolName}" takes for the ${entityType.name} id. Rename the argument, set extensions.virtual.mcp to false, or exclude the tool.`, 'MCP_INVALID_OPTIONS', 500);
      }

      const override = toolOverrides[toolName] || toolOverrides[rawName] || {};
      const depth = override.selectionDepth ?? selectionDepth;
      const collections = override.nestedCollections == null
        ? nestedCollections
        : normalizeNestedCollections(override.nestedCollections, `toolOverrides.${toolName}.nestedCollections`);
      const virtuals = virtualFieldsFor(field.type);
      const title = override.title || `Get ${entityType.name} ${fieldName}`;
      const description = override.description || buildVirtualFieldToolDescription(fieldName, field, entityType);
      const annotations = { ...buildAnnotations('virtualField', title, field), ...(override.annotations || {}) };
      const selection = override.selection
        ? normalizeSelection(override.selection)
        : buildSelectionSet(field.type, depth, collections, virtuals, new Set([entityType.name]));
      // The input schema and the operation declare the same required `id`.
      const requiredId = requiredIdArgument(target);

      const tool = {
        name: toolName,
        title,
        description,
        inputSchema: argumentsToJSONSchema([requiredId, ...field.args], defRegistry),
        annotations,
        kind: 'query',
      };
      if (!override.selection) {
        tool.outputSchema = buildVirtualFieldOutputSchema(target, depth, collections, virtuals);
      }
      tools.push(tool);
      // A `pagination` argument of the field gets the limits a root field's does.
      const pagination = field.args.find((arg) => arg.name === 'pagination');
      toolIndex[toolName] = {
        operation: buildVirtualFieldOperation(rawName, target, requiredId, selection),
        kind: 'query',
        op: 'virtualField',
        fieldName: target.byIdName,
        hasPagination: !!pagination,
        paginationType: pagination ? pagination.type : undefined,
        argNames: new Set([requiredId.name, ...field.args.map((arg) => arg.name)]),
        countKey: undefined,
        truncationKey: undefined,
        idempotent: annotations.idempotentHint === true,
        countSink: false,
      };
    }
  };

  addToolsFromType(queryType, 'query');
  addToolsFromType(schema.getMutationType(), 'mutation');
  buildVirtualFieldTools();

  return { tools, toolIndex };
};

/**
 * Validate the options, build the tool definitions and start the schemaPlugins
 * installation shared by {@link generateMCPTools} and {@link createMCPServer}.
 * Configuration is validated before any plugin hook runs.
 * @param {import('graphql').GraphQLSchema} schema
 * @param {Object} [options]
 * @returns {{ generated: { tools: Array, callTool: Function, getOperation: Function },
 *   ready: Promise<void>|null }} `ready` is pending while asynchronous
 *   `onSchemaChange` hooks run, and null when none are pending
 */
const prepareMCPTools = (schema, options = {}) => {
  // Invariant (shared with createHTTPMCPHandler): every validation runs before
  // applySchemaPlugins, so a setup error leaves the schema's resolvers as
  // they were.
  const { mode, execution } = resolveExecution(options.execution);
  const toolMiddleware = normalizeToolMiddleware(options.toolMiddleware);
  const limits = normalizeLimits(options.limits);
  const stringify = normalizeTextFormat(options.textFormat);
  const { tools, toolIndex } = buildToolDefinitions(schema, options, limits);
  validateDefaultPagination(limits, toolIndex);
  const ready = mode === 'in-process' ? applySchemaPlugins(schema, options.schemaPlugins) : null;
  const callTool = createCallTool({
    schema,
    toolIndex,
    mode,
    execution,
    context: options.context ?? {},
    // The caller's object, read on every call.
    limits: options.limits,
    toolMiddleware,
    ready,
    stringify,
  });
  const getOperation = (name) => {
    const entry = toolIndex[name];
    if (!entry) {
      throw new SimfinityError(`Unknown MCP tool: ${name}`, 'MCP_TOOL_NOT_FOUND', 404);
    }
    return entry.operation;
  };
  return { generated: { tools, callTool, getOperation }, ready };
};

/**
 * Generate MCP tool definitions and an executor from a Simfinity-generated
 * GraphQLSchema. Every root Query and Mutation field becomes a tool whose name
 * matches the GraphQL field name (e.g. `addbook`, `books`, `process_order`),
 * optionally prefixed via `toolNamePrefix`. Each tool carries a `title`, an
 * actionable `description` (reusing GraphQL type descriptions), an
 * `inputSchema`, an `outputSchema` and behavioral `annotations` (see
 * {@link classifyOperation} and {@link buildAnnotations}).
 *
 * Virtual fields (core's `extensions.virtual`) are read through their type's
 * tools. A virtual field with a required argument that has no default is
 * never selected by them, so the type's by-ID query also gets a read tool
 * named `<byIdQuery>_<field>` (e.g. `barbershop_busyRanges`) for it, unless
 * its `mcp` option is false. That tool takes the record's `id` and the
 * field's arguments, runs the by-ID query selecting only the field, and comes
 * after every root field's tool. `include`/`exclude`, `toolNamePrefix` and
 * `toolOverrides` apply to its name, and `includeTypes`/`excludeTypes` to the
 * type that declares the field. A field argument named `id` throws
 * MCP_INVALID_OPTIONS when that tool is published. Below any list position,
 * such as the records of list tools and the items of a nested collection or
 * embedded list in any tool, tools select only the virtual fields whose `mcp`
 * option is 'select'; elsewhere they select every virtual field without
 * required arguments, as any other field.
 *
 * @param {import('graphql').GraphQLSchema} schema schema returned by createSchema()
 * @param {Object} [options]
 * @param {{ mode?: 'in-process'|'remote', endpoint?: string, headers?: Object|Iterable,
 *   timeoutMs?: number, retry?: { attempts?: number, backoffMs?: number,
 *   retryAfter?: boolean, maxRetryAfterMs?: number, jitter?: boolean } }} [options.execution]
 *   execution strategy. Defaults to in-process execution against `schema`.
 *   The remote `endpoint` is passed to fetch: a URL with a username or
 *   password throws MCP_INVALID_EXECUTION_CONFIG at setup (fetch rejects it
 *   on every call); an endpoint fetch cannot request otherwise (relative,
 *   unparsable, not http(s)) fails each call with MCP_REMOTE_REQUEST_FAILED.
 *   Neither message quotes the URL. Remote `headers` (a plain object, a
 *   Headers instance, a Map or an array of [name, value] pairs; falsy for
 *   none) are merged over the JSON content type, and a `Content-Type` in any
 *   casing replaces it. `timeoutMs` aborts each slow remote attempt: a
 *   positive number of milliseconds (numeric strings accepted, fractions
 *   rounded up, capped at 2147483647); falsy or 0 disables it. `endpoint`,
 *   `headers` and `timeoutMs` are read again on every call, so later changes
 *   apply. Other headers or timeoutMs values throw
 *   MCP_INVALID_EXECUTION_CONFIG at setup, except that an own getter for
 *   either is not run at setup and a read that throws (an inherited getter
 *   or a Proxy whose token is not loaded yet) is checked per call. `retry` re-issues
 *   failed remote queries (never mutations) after transport failures, HTTP
 *   5xx or 429; retry k waits `backoffMs × k` (default 250). Opt-ins:
 *   `retryAfter: true` waits at least a retried response's Retry-After
 *   (delta-seconds or HTTP-date) and, when it asks for more than
 *   `maxRetryAfterMs` (default 10000), ends the retries with that failure;
 *   `jitter: true` adds a random wait of up to half of `backoffMs × k`.
 *   Client cancellation, including during a retry wait, rejects without
 *   retrying.
 * @param {Object|Function} [options.context] GraphQL context value (or a
 *   `(extra) => context` factory) passed through to in-process execution.
 * @param {string|string[]} [options.include] only expose these tool/field names
 *   or categories ('query' / 'mutation').
 * @param {string|string[]} [options.exclude] never expose these tool/field
 *   names or categories.
 * @param {string|string[]} [options.includeTypes] only expose tools whose
 *   entity (return) type has one of these names.
 * @param {string|string[]} [options.excludeTypes] never expose tools whose
 *   entity (return) type has one of these names.
 * @param {number} [options.selectionDepth=1] nesting depth for the auto-generated
 *   output selection set and output schema.
 * @param {'all'|'none'} [options.nestedCollections='all'] 'none' leaves nested
 *   collections (object list fields with a `pagination` argument, such as
 *   core's non-embedded one-to-many relations, each read with one query per
 *   returned row) out of the generated selection set and output schema.
 *   Other values throw MCP_INVALID_OPTIONS.
 * @param {'pretty'|'compact'} [options.textFormat='pretty'] JSON format of the
 *   text content block of results, which `limits.maxResultBytes` measures:
 *   pretty-printed, or 'compact' without whitespace. Other values throw
 *   MCP_INVALID_OPTIONS.
 * @param {boolean} [options.includeId] deprecated and ignored: every scalar/enum
 *   field without required arguments, `id` included, is always selected, and
 *   an object type with none selects `__typename`.
 * @param {string} [options.toolNamePrefix] prefix applied to every published
 *   tool name (e.g. 'catalog_'), for disambiguating multiple servers.
 * @param {Object} [options.toolOverrides] per-tool overrides keyed by tool (or
 *   field) name: `{ description, title, annotations, selectionDepth,
 *   nestedCollections, selection }` (a deprecated `includeId` is ignored). A
 *   tool's `nestedCollections` wins over the global one; every entry's value
 *   is validated, whether or not its tool is published. An explicit `selection`
 *   replaces the generated selection set, ignores `nestedCollections` (and
 *   omits the outputSchema, which could no longer be guaranteed accurate).
 * @param {Function|Array<Function>} [options.toolMiddleware] koa-style
 *   `(call, next) => result` functions run around every tool execution;
 *   `call` is `{ name, args, extra, kind, operation }`. A single function is a
 *   one-element stack. The stack is validated (MCP_INVALID_MIDDLEWARE) and
 *   copied at setup. A synchronous throw rejects the previous middleware's
 *   `next()` promise, as an async one does; a rejected `next()` promise that
 *   no middleware awaits or returns is dropped, never left unhandled. An
 *   undeclared argument key the caller sent that is still
 *   in `call.args` when the chain reaches execution is rejected
 *   (MCP_UNKNOWN_ARGUMENT, nothing executed); middleware may consume such a
 *   key by deleting it, and keys middleware adds are passed through.
 * @param {{ maxPageSize?: number, defaultPagination?: Object,
 *   maxResultBytes?: number }|null|false} [options.limits] guardrails: reject
 *   oversized pages/logical result payloads (including errors), inject default
 *   pagination when the caller sends none. An oversized mutation result is not
 *   rejected, because the write already ran: a success returns the root id(s)
 *   and a `truncated` notice with `isError: false` and `_meta.truncated`; an
 *   error keeps MCP_RESULT_TOO_LARGE with `extensions.applied` (true or
 *   'unknown'). Limit diagnostics, including that notice and
 *   MCP_UNKNOWN_ARGUMENT, are exempt from the cap. Validated at setup
 *   (MCP_INVALID_LIMITS): a falsy `limits`, `defaultPagination` or cap means
 *   unset; caps must be numbers of at least 1 (numeric strings and bigints
 *   are converted; NaN applies no cap and warns); `defaultPagination` must be
 *   valid for every published tool's `pagination` argument type. The object
 *   is read again on every call, so later changes apply.
 * @param {Array<Object|false|null|undefined>} [options.schemaPlugins]
 *   Envelop-style plugins (e.g. simfinity's createAuthPlugin) whose
 *   `onSchemaChange` hook is applied before serving, so resolver-wrapping
 *   plugins also apply to in-process execution. Entries are validated first
 *   (MCP_INVALID_SCHEMA_PLUGIN); calls wait for asynchronous hooks and reject
 *   when one fails.
 * @returns {{ tools: Array, callTool: Function, getOperation: Function }}
 */
export const generateMCPTools = (schema, options = {}) => {
  const { generated, ready } = prepareMCPTools(schema, options);
  if (ready) {
    // Every call awaits `ready` and rejects with the installer's error; this
    // handler only keeps an unused failed installation from crashing the process.
    ready.catch((err) => {
      console.warn('[simfinity-mcp] An asynchronous schemaPlugins installer failed; every tool call will reject:', err);
    });
  }
  return generated;
};

const isModuleNotFound = (err) => !!err && (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND');

const sdkNotInstalledError = (what) => new SimfinityError(
  `The optional dependency "@modelcontextprotocol/sdk" is required for ${what}. Install it with: npm install @modelcontextprotocol/sdk`,
  'MCP_SDK_NOT_INSTALLED',
  500,
);

const sdkLoadFailedError = (err) => new SimfinityError(
  `Failed to load "@modelcontextprotocol/sdk": ${err && err.message ? err.message : err}`,
  'MCP_SDK_LOAD_FAILED',
  500,
);

const sdkIncompatibleError = (what) => new SimfinityError(
  `The installed "@modelcontextprotocol/sdk" does not provide ${what}; install a supported version with: npm install @modelcontextprotocol/sdk@^1.31.0`,
  'MCP_SDK_INCOMPATIBLE',
  500,
);

const loadSdkCore = async () => {
  let sdk;
  try {
    const [serverModule, typesModule] = await Promise.all([
      import('@modelcontextprotocol/sdk/server/index.js'),
      import('@modelcontextprotocol/sdk/types.js'),
    ]);
    sdk = {
      Server: serverModule.Server,
      ListToolsRequestSchema: typesModule.ListToolsRequestSchema,
      CallToolRequestSchema: typesModule.CallToolRequestSchema,
    };
  } catch (err) {
    if (isModuleNotFound(err)) {
      throw sdkNotInstalledError('MCP servers');
    }
    throw sdkLoadFailedError(err);
  }
  if (typeof sdk.Server !== 'function' || !sdk.ListToolsRequestSchema || !sdk.CallToolRequestSchema) {
    throw sdkIncompatibleError('the MCP Server API');
  }
  return sdk;
};

const loadStdioTransport = async () => {
  let StdioServerTransport;
  try {
    ({ StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js'));
  } catch (err) {
    if (isModuleNotFound(err)) {
      throw sdkIncompatibleError('the stdio transport');
    }
    throw sdkLoadFailedError(err);
  }
  if (typeof StdioServerTransport !== 'function') {
    throw sdkIncompatibleError('the stdio transport');
  }
  return StdioServerTransport;
};

const newServerInstance = (sdk, tools, callTool, options) => {
  const server = new sdk.Server(
    {
      name: options.serverName || 'simfinity-mcp',
      version: options.serverVersion || '1.0.0',
    },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(sdk.ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => {
      const published = {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      };
      if (tool.outputSchema) {
        published.outputSchema = tool.outputSchema;
      }
      return published;
    }),
  }));

  server.setRequestHandler(sdk.CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    return callTool(name, args || {}, extra);
  });

  return server;
};

/**
 * Validate the options, run the schemaPlugins and build an SDK Server from an
 * already loaded SDK, so SDK errors always come before any plugin runs.
 * @param {Object} sdk from {@link loadSdkCore}
 * @param {import('graphql').GraphQLSchema} schema
 * @param {Object} options
 * @returns {Promise<Object>} SDK Server instance
 */
const buildServer = async (sdk, schema, options) => {
  const { generated: { tools, callTool }, ready } = prepareMCPTools(schema, options);
  if (ready) {
    await ready;
  }
  return newServerInstance(sdk, tools, callTool, options);
};

/**
 * Create a transport-agnostic MCP Server exposing every GraphQL operation as a
 * tool. Requires the optional `@modelcontextprotocol/sdk` dependency.
 * @param {import('graphql').GraphQLSchema} schema
 * @param {Object} [options] same options as {@link generateMCPTools}, plus
 *   `serverName` and `serverVersion`.
 * @returns {Promise<Object>} an SDK Server instance (call `server.connect(transport)`),
 *   resolved once asynchronous schemaPlugins hooks finish (rejects if one fails)
 */
export const createMCPServer = async (schema, options = {}) => buildServer(
  await loadSdkCore(),
  schema,
  options,
);

/**
 * Create an MCP Server and connect it over stdio. Use for a standalone MCP
 * executable (e.g. for Cursor / Claude Desktop). The SDK and its stdio
 * transport are loaded before the options are validated and schemaPlugins run.
 * @param {import('graphql').GraphQLSchema} schema
 * @param {Object} [options] same options as {@link createMCPServer}.
 * @returns {Promise<Object>} the connected SDK Server instance
 */
export const startStdioMCPServer = async (schema, options = {}) => {
  // Load the core first so a missing SDK reports MCP_SDK_NOT_INSTALLED, while a
  // present-but-old SDK missing the transport reports MCP_SDK_INCOMPATIBLE.
  // Both load before the options are validated and schemaPlugins run, so an
  // SDK error leaves the schema's resolvers as they were.
  const sdk = await loadSdkCore();
  const StdioServerTransport = await loadStdioTransport();
  const server = await buildServer(sdk, schema, options);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
};

/**
 * Create an Express-style request handler that serves the MCP over Streamable
 * HTTP, suitable for mounting next to the existing GraphQL endpoint (mount it
 * for every method, e.g. `app.all`). A fresh, stateless server + transport
 * pair is created per POST request. Other methods get 405 with `Allow: POST`
 * and a JSON-RPC error, without invoking `context` or `onError`: a stateless
 * server has no session to terminate (DELETE) and no standalone SSE stream
 * (GET).
 *
 * The tool definitions are built once; the execution context is resolved per
 * request. When `options.context` is a function it is invoked as
 * `(req, extra) => context` for every call, where `req` is the Express request,
 * enabling per-request authentication (e.g. reading an Authorization header).
 * The SDK and its Streamable HTTP transport are loaded first, then
 * `transportOptions`, `execution`, `toolMiddleware`, `limits`, `textFormat`,
 * `nestedCollections` and `schemaPlugins` are validated, and asynchronous
 * schemaPlugins hooks awaited, before the handler is returned.
 *
 * @param {import('graphql').GraphQLSchema} schema
 * @param {Object} [options] same options as {@link createMCPServer}; in HTTP mode
 *   a function `context` receives `(req, extra)`. Additionally:
 * @param {Object} [options.transportOptions] extra options passed to the SDK's
 *   StreamableHTTPServerTransport (e.g. `enableDnsRebindingProtection`,
 *   `allowedHosts`, `allowedOrigins` — recommended for localhost deployments).
 *   Session generators/callbacks and event stores are rejected with
 *   MCP_INVALID_TRANSPORT_OPTIONS; this handler is always stateless.
 * @param {Function} [options.onError] `(err, req, res)` invoked when the
 *   handler fails; the handler then responds 500 (JSON-RPC internal error) if
 *   headers were not already sent.
 * @returns {Promise<Function>} async `(req, res) => {}` handler
 */
export const createHTTPMCPHandler = async (schema, options = {}) => {
  const sdk = await loadSdkCore();
  let StreamableHTTPServerTransport;
  try {
    ({ StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js'));
  } catch (err) {
    if (isModuleNotFound(err)) {
      throw sdkIncompatibleError('the Streamable HTTP transport');
    }
    throw sdkLoadFailedError(err);
  }
  if (typeof StreamableHTTPServerTransport !== 'function') {
    throw sdkIncompatibleError('the Streamable HTTP transport');
  }

  // Validation runs after the SDK loads and before applySchemaPlugins, as in
  // prepareMCPTools.
  const transportOptions = options.transportOptions || {};
  const unsupportedOptions = ['sessionIdGenerator', 'onsessioninitialized', 'onsessionclosed', 'eventStore']
    .filter((key) => transportOptions[key] !== undefined);
  if (unsupportedOptions.length) {
    throw new SimfinityError(`Stateless MCP HTTP handlers do not support transport options: ${unsupportedOptions.join(', ')}`, 'MCP_INVALID_TRANSPORT_OPTIONS', 500);
  }
  const { mode, execution } = resolveExecution(options.execution);
  const toolMiddleware = normalizeToolMiddleware(options.toolMiddleware);
  const limits = normalizeLimits(options.limits);
  const stringify = normalizeTextFormat(options.textFormat);
  const { tools, toolIndex } = buildToolDefinitions(schema, options, limits);
  validateDefaultPagination(limits, toolIndex);
  if (mode === 'in-process') {
    await applySchemaPlugins(schema, options.schemaPlugins);
  }

  return async (req, res) => {
    try {
      // Stateless: there is no session to terminate (DELETE) and nothing to
      // send on a standalone SSE stream (GET), which would stay open idle.
      // MCP clients treat a 405 on GET as "no server stream".
      if (String(req.method).toUpperCase() !== 'POST') {
        res.writeHead(405, { Allow: 'POST', 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed.' },
          id: null,
        }));
        return;
      }
      const context = typeof options.context === 'function'
        ? (extra) => options.context(req, extra)
        : (options.context ?? {});
      const callTool = createCallTool({
        schema,
        toolIndex,
        mode,
        execution,
        context,
        // Re-read per request, and by every call, as before.
        limits: options.limits,
        toolMiddleware,
        stringify,
      });
      const server = newServerInstance(sdk, tools, callTool, options);
      const transport = new StreamableHTTPServerTransport({
        ...transportOptions,
        sessionIdGenerator: undefined,
      });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (typeof options.onError === 'function') {
        try {
          await options.onError(err, req, res);
        } catch {
          // onError (sync or async) must never mask the original failure handling
        }
      }
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        }));
      } else {
        try {
          res.end();
        } catch {
          // socket already gone
        }
      }
    }
  };
};

const mcp = {
  generateMCPTools,
  graphqlArgsToJSONSchema,
  createMCPServer,
  startStdioMCPServer,
  createHTTPMCPHandler,
};

export default mcp;
