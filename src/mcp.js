import {
  graphql,
  getNamedType,
  astFromValue,
  valueFromASTUntyped,
  GraphQLNonNull,
  GraphQLList,
  GraphQLScalarType,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLObjectType,
} from 'graphql';
import SimfinityError from './errors/simfinity.error.js';

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
const SIMFINITY_FILTER_DOCS = {
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
  'QLPagination.count': 'When true, list queries return the total record count in the tool result `_meta.count` (aggregate queries ignore this flag).',
  QLSortExpression: 'Sort specification: an ordered list of sort terms.',
  QLSort: 'A single sort term: the field to sort by and the direction.',
  'QLSort.field': 'Field name to sort by.',
  'QLSort.order': 'Sort direction (ASC or DESC).',
  QLSortOrder: 'Sort direction: ASC (ascending) or DESC (descending).',
  QLAggregationOperation: 'Aggregation operation: SUM, COUNT, AVG, MIN or MAX.',
  QLTypeAggregationExpression: 'Aggregation specification: a groupId field path to group by and a list of facts to compute.',
  QLTypeAggregationFact: 'A single aggregation fact: the operation, an output factName and the field path to aggregate.',
  IdInputType: 'Reference to a related entity by its id.',
};

/**
 * Curated fallback documentation for well-known operation-level arguments that
 * Simfinity injects into list and aggregate queries.
 */
const SIMFINITY_ARG_DOCS = {
  id: 'Unique identifier (id) of the record.',
  pagination: 'Pagination: page (1-based), size, and an optional count flag (on list queries, the total is delivered in the tool result `_meta.count`).',
  sort: 'Sort results by one or more fields (terms of { field, order: ASC | DESC }).',
  AND: 'Logical AND group(s): every nested condition or group must match.',
  OR: 'Logical OR group(s): at least one nested condition or group must match.',
  aggregation: 'Aggregation spec: groupId to group by and facts [{ operation: SUM | COUNT | AVG | MIN | MAX, factName, path }].',
};

/**
 * Resolve the JSON Schema primitive type for a GraphQL scalar. Custom validated
 * scalars (created via createValidatedScalar) expose a `baseScalarType`, which is
 * used to derive the underlying primitive. Date-like scalars (the names
 * Simfinity maps to Mongoose Date) carry a string `format`. Unknown/opaque
 * scalars map to an empty schema, meaning "any value is accepted", with a
 * curated description where one exists (e.g. QLValue).
 * @param {import('graphql').GraphQLScalarType} type
 * @returns {Object} JSON Schema fragment
 */
const scalarToJSONSchema = (type) => {
  const name = type.baseScalarType ? type.baseScalarType.name : type.name;
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
    default: {
      const doc = SIMFINITY_FILTER_DOCS[name];
      return doc ? { description: doc } : {};
    }
  }
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
 * GraphQL data contains `null` for every nullable position (missing optional
 * fields, get-by-id misses), so output schemas must allow it or validating MCP
 * clients reject perfectly valid `structuredContent`. Schemas without a `type`
 * keyword already accept null and pass through unchanged.
 * @param {Object} schema
 * @returns {Object}
 */
const nullableSchema = (schema) => {
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
  if (defs[type.name]) {
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
  if (defs[type.name]) {
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
  if (type instanceof GraphQLNonNull) {
    const inner = typeToJSONSchema(type.ofType, defs);
    return { schema: inner.schema, isRequired: true };
  }
  if (type instanceof GraphQLList) {
    const inner = typeToJSONSchema(type.ofType, defs);
    return { schema: { type: 'array', items: inner.schema }, isRequired: false };
  }
  if (type instanceof GraphQLScalarType) {
    return { schema: scalarToJSONSchema(type), isRequired: false };
  }
  if (type instanceof GraphQLEnumType) {
    ensureEnumDef(type, defs);
    return { schema: { $ref: `#/$defs/${type.name}` }, isRequired: false };
  }
  if (type instanceof GraphQLInputObjectType) {
    ensureInputDef(type, defs);
    return { schema: { $ref: `#/$defs/${type.name}` }, isRequired: false };
  }
  return { schema: {}, isRequired: false };
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

/**
 * Build the MCP `inputSchema` (JSON Schema) for a single GraphQL field by
 * converting every argument with full fidelity (scalars, enums, input objects,
 * lists, non-null wrappers and recursive types via `$defs`/`$ref`). Argument and
 * type descriptions are propagated, with curated fallbacks for Simfinity's
 * synthetic filter/pagination/sort/aggregation arguments. Arguments with a
 * GraphQL default value carry a JSON Schema `default` and are never required.
 * @param {import('graphql').GraphQLField} field
 * @returns {Object} JSON Schema describing the tool input
 */
export const graphqlArgsToJSONSchema = (field) => {
  const defs = {};
  const properties = {};
  const required = [];

  for (const arg of field.args || []) {
    const { schema, isRequired } = typeToJSONSchema(arg.type, defs);
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

  const result = { type: 'object', properties };
  if (required.length) {
    result.required = required;
  }
  if (Object.keys(defs).length) {
    result.$defs = defs;
  }
  return result;
};

const hasRequiredArgs = (field) => (field.args || [])
  .some((arg) => arg.type instanceof GraphQLNonNull && arg.defaultValue === undefined);

/**
 * Auto-generate a GraphQL selection set string for a field's return type so MCP
 * callers only need to supply arguments. Scalar/enum leaves are always selected;
 * object fields are expanded up to `depth` levels, always falling back to `id`
 * when nothing else is selectable. Interface/union return types and object types
 * with no selectable leaves fall back to `__typename` so the generated document
 * is always statically valid. Cycles are avoided via the `visited` set.
 * @param {import('graphql').GraphQLType} type return type of the field
 * @param {number} depth remaining nesting depth for object expansion
 * @param {boolean} includeId always include `id` when present and nothing else selected
 * @param {Set<string>} visited already-expanded object type names
 * @returns {string} selection set (with leading space) or empty string for leaves
 */
const buildSelectionSet = (type, depth, includeId, visited = new Set()) => {
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
      if (!hasRequiredArgs(field)) {
        lines.push(fieldName);
      }
    } else if (fieldNamed instanceof GraphQLObjectType) {
      if (depth > 0 && !nextVisited.has(fieldNamed.name) && !hasRequiredArgs(field)) {
        const sub = buildSelectionSet(field.type, depth - 1, includeId, nextVisited);
        if (sub) {
          lines.push(`${fieldName}${sub}`);
        }
      }
    }
  }

  if (lines.length === 0 && includeId && fields.id && !hasRequiredArgs(fields.id)) {
    lines.push('id');
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

const isEmptyObjectSchema = (schema) => {
  if (!schema) {
    return true;
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('object')) {
    return !schema.properties || Object.keys(schema.properties).length === 0;
  }
  if (types.includes('array')) {
    return isEmptyObjectSchema(schema.items);
  }
  return false;
};

/**
 * Build a JSON Schema describing a field's return type, mirroring the inclusion
 * rules of {@link buildSelectionSet} (scalars/enums always; object fields up to
 * `depth`; `id`/`__typename` fallbacks) so the schema matches what the tool
 * actually returns. Every nullable GraphQL position accepts `null` in the
 * schema. GraphQL type and field descriptions are propagated.
 * @param {import('graphql').GraphQLType} type
 * @param {number} depth
 * @param {boolean} includeId
 * @param {Set<string>} visited
 * @returns {Object} JSON Schema for the return type
 */
const returnTypeToSchema = (type, depth, includeId, visited = new Set()) => {
  if (type instanceof GraphQLNonNull) {
    return unwrappedReturnTypeToSchema(type.ofType, depth, includeId, visited);
  }
  return nullableSchema(unwrappedReturnTypeToSchema(type, depth, includeId, visited));
};

function unwrappedReturnTypeToSchema(type, depth, includeId, visited) {
  if (type instanceof GraphQLList) {
    return { type: 'array', items: returnTypeToSchema(type.ofType, depth, includeId, visited) };
  }
  if (type instanceof GraphQLScalarType) {
    return scalarToJSONSchema(type);
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
      if (!hasRequiredArgs(field)) {
        properties[fieldName] = withDescription(
          returnTypeToSchema(field.type, depth, includeId, nextVisited),
          field.description,
        );
      }
    } else if (fieldNamed instanceof GraphQLObjectType) {
      if (depth > 0 && !nextVisited.has(fieldNamed.name) && !hasRequiredArgs(field)) {
        const sub = returnTypeToSchema(field.type, depth - 1, includeId, nextVisited);
        if (!isEmptyObjectSchema(sub)) {
          properties[fieldName] = withDescription(sub, field.description);
        }
      }
    }
  }

  if (Object.keys(properties).length === 0 && includeId && fields.id && !hasRequiredArgs(fields.id)) {
    properties.id = withDescription(
      returnTypeToSchema(fields.id.type, depth, includeId, nextVisited),
      fields.id.description,
    );
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
 * field name so that `structuredContent = graphqlResult.data` (which is shaped
 * `{ [fieldName]: value }`) conforms to the schema.
 * @param {string} fieldName
 * @param {import('graphql').GraphQLField} field
 * @param {number} selectionDepth
 * @param {boolean} includeId
 * @returns {Object} JSON Schema describing the tool output
 */
const buildOutputSchema = (fieldName, field, selectionDepth, includeId) => ({
  type: 'object',
  properties: {
    [fieldName]: returnTypeToSchema(field.type, selectionDepth, includeId),
  },
});

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
  const varDefs = args
    .map((arg) => `$${arg.name}: ${arg.type.toString()}`)
    .join(', ');
  const argUsage = args
    .map((arg) => `${arg.name}: $${arg.name}`)
    .join(', ');

  const header = varDefs ? `${kind} ${fieldName}Operation(${varDefs})` : `${kind} ${fieldName}Operation`;
  const call = argUsage ? `${fieldName}(${argUsage})` : fieldName;
  return `${header} {\n  ${call}${selection}\n}`;
};

const isListType = (type) => {
  const inner = type instanceof GraphQLNonNull ? type.ofType : type;
  return inner instanceof GraphQLList;
};

const hasArg = (field, name) => (field.args || []).some((arg) => arg.name === name);

/**
 * Classify a root field into a logical operation kind so descriptions, titles
 * and annotations can be tailored. Queries are classified structurally.
 * Generated CRUD mutations are recognized by the placeholder descriptions
 * Simfinity stamps on them ('add'/'update'/'delete' — see buildMutation in
 * src/index.js); name prefixes are only a fallback for description-less fields,
 * so custom mutations and state-machine actions whose names happen to start
 * with add/update/delete are not mislabeled.
 * @param {'query'|'mutation'} kind
 * @param {string} fieldName
 * @param {import('graphql').GraphQLField} field
 * @returns {'single'|'list'|'aggregate'|'add'|'update'|'delete'|'custom'}
 */
const classifyOperation = (kind, fieldName, field) => {
  if (kind === 'query') {
    if (hasArg(field, 'aggregation')) {
      return 'aggregate';
    }
    if (isListType(field.type)) {
      return 'list';
    }
    return 'single';
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
  if (!field.description) {
    if (fieldName.startsWith('add')) {
      return 'add';
    }
    if (fieldName.startsWith('update')) {
      return 'update';
    }
    if (fieldName.startsWith('delete')) {
      return 'delete';
    }
  }
  return 'custom';
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

const buildAnnotations = (op, title) => {
  const base = { title, openWorldHint: false };
  switch (op) {
    case 'single':
    case 'list':
    case 'aggregate':
      return { ...base, readOnlyHint: true };
    case 'update':
      return { ...base, readOnlyHint: false, idempotentHint: true };
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

/**
 * Combine abort signals into one (Node 18-compatible fallback for
 * AbortSignal.any).
 * @param {Array<AbortSignal|undefined>} signals
 * @returns {AbortSignal|undefined}
 */
const combineAbortSignals = (signals) => {
  const list = signals.filter(Boolean);
  if (list.length === 0) {
    return undefined;
  }
  if (list.length === 1) {
    return list[0];
  }
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(list);
  }
  const controller = new AbortController();
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const remoteTransportError = (message, code, extra = {}) => ({
  errors: [{ message, extensions: { code, ...extra } }],
});

/**
 * Execute a GraphQL operation against a remote HTTP endpoint. Transport
 * failures (network errors, timeouts, non-2xx statuses, non-JSON bodies) are
 * mapped to a GraphQL-shaped `{ errors }` result so they surface to the MCP
 * client as a regular `isError` tool result instead of an opaque exception.
 * Network errors, timeouts, HTTP 5xx and 429 are retried (queries only) when
 * `execution.retry` is configured.
 * @param {string} query
 * @param {Object} variables
 * @param {{ endpoint: string, headers?: Object, timeoutMs?: number,
 *   retry?: { attempts?: number, backoffMs?: number } }} execution
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
  let lastFailure;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      await sleep(backoffMs * (attempt - 1));
    }
    const requestSignal = combineAbortSignals([
      signal,
      execution.timeoutMs ? AbortSignal.timeout(execution.timeoutMs) : undefined,
    ]);

    let response;
    try {
      response = await globalThis.fetch(execution.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(execution.headers || {}) },
        body: JSON.stringify({ query, variables }),
        signal: requestSignal,
      });
    } catch (err) {
      if (signal && signal.aborted) {
        throw err;
      }
      lastFailure = remoteTransportError(
        `GraphQL endpoint request failed: ${err && err.message ? err.message : err}`,
        'MCP_REMOTE_REQUEST_FAILED',
      );
      continue;
    }

    if (!response.ok) {
      // GraphQL-over-HTTP servers commonly reply 400 with a real GraphQL
      // errors body (validation/coercion failures) — pass that through
      // verbatim instead of masking it with a synthesized transport error.
      let errorBody;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = undefined;
      }
      const isGraphQLBody = !!errorBody && (Array.isArray(errorBody.errors) || errorBody.data !== undefined);
      lastFailure = isGraphQLBody ? errorBody : remoteTransportError(
        `GraphQL endpoint responded with HTTP ${response.status}`,
        'MCP_REMOTE_HTTP_ERROR',
        { status: response.status },
      );
      if (response.status >= 500 || response.status === 429) {
        continue;
      }
      return lastFailure;
    }

    let body;
    try {
      body = await response.json();
    } catch {
      return remoteTransportError('GraphQL endpoint returned a non-JSON response', 'MCP_REMOTE_INVALID_RESPONSE');
    }
    if (!body || (body.data === undefined && !body.errors)) {
      return remoteTransportError('GraphQL endpoint returned an unexpected payload (no data or errors)', 'MCP_REMOTE_INVALID_RESPONSE');
    }
    return body;
  }
  return lastFailure;
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
  return { mode, execution: resolved };
};

/**
 * Apply Envelop-style schema plugins (e.g. simfinity's createAuthPlugin) to the
 * schema by invoking their `onSchemaChange` hooks. In a regular GraphQL server
 * Envelop fires these hooks at startup; standalone MCP servers execute via bare
 * `graphql()` and would otherwise silently skip resolver-wrapping plugins such
 * as field-level auth.
 * @param {import('graphql').GraphQLSchema} schema
 * @param {Array<Object>} schemaPlugins
 */
const applySchemaPlugins = (schema, schemaPlugins) => {
  for (const plugin of schemaPlugins || []) {
    if (plugin && typeof plugin.onSchemaChange === 'function') {
      plugin.onSchemaChange({ schema, replaceSchema: () => {} });
    }
  }
};

/**
 * Compose `toolMiddleware` functions (koa-style `(call, next)`) around the
 * terminal executor. Middleware may inspect/modify `call.args`, short-circuit
 * by returning a result without calling `next()`, or throw.
 * @param {Array<Function>|undefined} middlewares
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
      if (i <= lastIndex) {
        return Promise.reject(new SimfinityError('next() called multiple times in MCP tool middleware', 'MCP_MIDDLEWARE_ERROR', 500));
      }
      lastIndex = i;
      if (i === middlewares.length) {
        return Promise.resolve(terminal(call));
      }
      return Promise.resolve(middlewares[i](call, () => dispatch(i + 1)));
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

const limitErrorResult = (message, code) => ({
  content: [{
    type: 'text',
    text: JSON.stringify({ errors: [{ message, extensions: { code } }] }, null, 2),
  }],
  isError: true,
});

/**
 * Build the `callTool` executor bound to a given execution mode and context.
 * @param {Object} params
 * @param {import('graphql').GraphQLSchema} params.schema
 * @param {Object} params.toolIndex operation index from {@link buildToolDefinitions}
 * @param {'in-process'|'remote'} params.mode
 * @param {Object} params.execution
 * @param {Object|Function} params.context GraphQL context value or factory
 * @param {Object} [params.limits] result/pagination guardrails
 * @param {Array<Function>} [params.toolMiddleware]
 * @returns {Function} async `(name, args, extra) => CallToolResult`
 */
const createCallTool = ({
  schema, toolIndex, mode, execution, context, limits = {}, toolMiddleware,
}) => {
  if (limits.defaultPagination && limits.maxPageSize
      && typeof limits.defaultPagination.size === 'number'
      && limits.defaultPagination.size > limits.maxPageSize) {
    // Fail at setup: otherwise every unpaginated call would get an isError
    // blaming the caller for a page size the server itself injected.
    throw new SimfinityError(`limits.defaultPagination.size (${limits.defaultPagination.size}) exceeds limits.maxPageSize (${limits.maxPageSize})`, 'MCP_INVALID_LIMITS', 500);
  }

  const terminal = async (call) => {
    const entry = toolIndex[call.name];
    if (!entry) {
      throw new SimfinityError(`Unknown MCP tool: ${call.name}`, 'MCP_TOOL_NOT_FOUND', 404);
    }
    if (call.extra && call.extra.signal && call.extra.signal.aborted) {
      throw new SimfinityError(`MCP tool call cancelled: ${call.name}`, 'MCP_CALL_CANCELLED', 499);
    }

    let args = call.args || {};
    if (entry.hasPagination) {
      if (limits.defaultPagination && args.pagination == null) {
        args = { ...args, pagination: { ...limits.defaultPagination } };
      }
      const size = args.pagination ? args.pagination.size : undefined;
      if (limits.maxPageSize && typeof size === 'number' && size > limits.maxPageSize) {
        return limitErrorResult(
          `pagination.size ${size} exceeds the maximum allowed page size ${limits.maxPageSize}. Request a smaller page.`,
          'MCP_PAGE_SIZE_EXCEEDED',
        );
      }
    }

    let result;
    let contextValue;
    let wantsCount = false;
    if (mode === 'remote') {
      result = await executeRemote(entry.operation, args, execution, {
        signal: call.extra ? call.extra.signal : undefined,
        canRetry: entry.kind === 'query',
      });
    } else {
      contextValue = typeof context === 'function' ? await context(call.extra) : context;
      // Counted list calls get a private context layer: simfinity's find
      // resolver writes context.count, and reading it back from a context
      // object shared across calls would race concurrent calls and surface
      // stale counts on operations (e.g. aggregates) that never write one.
      wantsCount = entry.op === 'list'
        && !!(args.pagination && args.pagination.count === true)
        && contextValue !== null && typeof contextValue === 'object';
      if (wantsCount) {
        contextValue = Object.create(contextValue);
      }
      result = await graphql({
        schema,
        source: entry.operation,
        variableValues: args,
        contextValue,
      });
    }

    const isError = !!(result.errors && result.errors.length);
    if (isError) {
      const payload = { errors: result.errors };
      if (result.data != null) {
        // Keep partial results visible alongside the errors.
        payload.data = result.data;
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }

    const text = JSON.stringify(result.data, null, 2);
    if (limits.maxResultBytes) {
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > limits.maxResultBytes) {
        return limitErrorResult(
          `Result of ${bytes} bytes exceeds maxResultBytes (${limits.maxResultBytes}). Narrow the query, lower selectionDepth or paginate.`,
          'MCP_RESULT_TOO_LARGE',
        );
      }
    }

    const response = {
      content: [{ type: 'text', text }],
      isError: false,
    };
    if (result.data != null) {
      response.structuredContent = result.data;
    }
    const count = mode === 'remote'
      ? (result.extensions && typeof result.extensions.count === 'number' ? result.extensions.count : undefined)
      // Own-property check: only a count written DURING this call counts.
      : (wantsCount && Object.hasOwn(contextValue, 'count') && typeof contextValue.count === 'number' ? contextValue.count : undefined);
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
    return run({
      name, args, extra, kind: entry.kind, operation: entry.operation,
    });
  };
};

/**
 * Build the context-independent tool definitions and the operation index from a
 * Simfinity-generated GraphQLSchema. Shared by {@link generateMCPTools} and the
 * transport factories so the (potentially expensive) schema traversal happens
 * once, while execution context can be bound per request.
 * @param {import('graphql').GraphQLSchema} schema
 * @param {Object} [options]
 * @returns {{ tools: Array, toolIndex: Object }}
 */
const buildToolDefinitions = (schema, options = {}) => {
  if (!schema || typeof schema.getQueryType !== 'function') {
    throw new SimfinityError('A valid GraphQLSchema is required to generate MCP tools', 'MCP_INVALID_SCHEMA', 500);
  }

  const {
    selectionDepth = 1,
    includeId = true,
    toolNamePrefix = '',
    toolOverrides = {},
  } = options;
  const include = toArray(options.include);
  const exclude = toArray(options.exclude);
  const includeTypes = toArray(options.includeTypes);
  const excludeTypes = toArray(options.excludeTypes);

  if (toolNamePrefix && !/^[a-zA-Z0-9_-]+$/.test(toolNamePrefix)) {
    throw new SimfinityError(`Invalid toolNamePrefix "${toolNamePrefix}": only letters, digits, underscore and hyphen are allowed`, 'MCP_INVALID_TOOL_NAME', 500);
  }

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
      const withId = override.includeId ?? includeId;
      const title = override.title || buildToolTitle(op, fieldName, entityType);
      const description = override.description || buildToolDescription(op, fieldName, field, entityType);
      const annotations = { ...buildAnnotations(op, title), ...(override.annotations || {}) };
      const selection = override.selection
        ? normalizeSelection(override.selection)
        : buildSelectionSet(field.type, depth, withId);

      const tool = {
        name: toolName,
        title,
        description,
        inputSchema: graphqlArgsToJSONSchema(field),
        annotations,
        kind,
      };
      // An explicit selection override makes the mirrored output schema
      // unreliable, so it is omitted rather than published wrong.
      if (!override.selection) {
        tool.outputSchema = buildOutputSchema(fieldName, field, depth, withId);
      }
      tools.push(tool);
      toolIndex[toolName] = {
        operation: buildOperation(kind, fieldName, field, selection),
        kind,
        op,
        fieldName,
        hasPagination: hasArg(field, 'pagination'),
      };
    }
  };

  addToolsFromType(queryType, 'query');
  addToolsFromType(schema.getMutationType(), 'mutation');

  return { tools, toolIndex };
};

/**
 * Generate MCP tool definitions and an executor from a Simfinity-generated
 * GraphQLSchema. Every root Query and Mutation field becomes a tool whose name
 * matches the GraphQL field name (e.g. `addbook`, `books`, `process_order`),
 * optionally prefixed via `toolNamePrefix`. Each tool carries a `title`, an
 * actionable `description` (reusing GraphQL type descriptions), an
 * `inputSchema`, an `outputSchema` and behavioral `annotations`.
 *
 * @param {import('graphql').GraphQLSchema} schema schema returned by createSchema()
 * @param {Object} [options]
 * @param {{ mode?: 'in-process'|'remote', endpoint?: string, headers?: Object,
 *   timeoutMs?: number, retry?: { attempts?: number, backoffMs?: number } }} [options.execution]
 *   execution strategy. Defaults to in-process execution against `schema`.
 *   `timeoutMs` aborts slow remote requests; `retry` re-issues failed remote
 *   queries (never mutations) after transport failures, HTTP 5xx or 429.
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
 * @param {boolean} [options.includeId=true] always select `id` when nothing else
 *   is selectable on an object type.
 * @param {string} [options.toolNamePrefix] prefix applied to every published
 *   tool name (e.g. 'catalog_'), for disambiguating multiple servers.
 * @param {Object} [options.toolOverrides] per-tool overrides keyed by tool (or
 *   field) name: `{ description, title, annotations, selectionDepth, includeId,
 *   selection }`. An explicit `selection` replaces the generated selection set
 *   (and omits the outputSchema, which could no longer be guaranteed accurate).
 * @param {Array<Function>} [options.toolMiddleware] koa-style
 *   `(call, next) => result` functions run around every tool execution;
 *   `call` is `{ name, args, extra, kind, operation }`.
 * @param {{ maxPageSize?: number, defaultPagination?: Object,
 *   maxResultBytes?: number }} [options.limits] guardrails: reject oversized
 *   pages/results, inject default pagination when the caller sends none.
 * @param {Array<Object>} [options.schemaPlugins] Envelop-style plugins (e.g.
 *   simfinity's createAuthPlugin) whose `onSchemaChange` hook is applied before
 *   serving, so resolver-wrapping plugins also apply to in-process execution.
 * @returns {{ tools: Array, callTool: Function, getOperation: Function }}
 */
export const generateMCPTools = (schema, options = {}) => {
  const { mode, execution } = resolveExecution(options.execution);
  if (mode === 'in-process') {
    applySchemaPlugins(schema, options.schemaPlugins);
  }
  const { tools, toolIndex } = buildToolDefinitions(schema, options);
  const callTool = createCallTool({
    schema,
    toolIndex,
    mode,
    execution,
    context: options.context ?? {},
    limits: options.limits,
    toolMiddleware: options.toolMiddleware,
  });
  const getOperation = (name) => {
    const entry = toolIndex[name];
    if (!entry) {
      throw new SimfinityError(`Unknown MCP tool: ${name}`, 'MCP_TOOL_NOT_FOUND', 404);
    }
    return entry.operation;
  };
  return { tools, callTool, getOperation };
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
  `The installed "@modelcontextprotocol/sdk" does not provide ${what}; upgrade it with: npm install @modelcontextprotocol/sdk@latest`,
  'MCP_SDK_INCOMPATIBLE',
  500,
);

const loadSdkCore = async () => {
  try {
    const [serverModule, typesModule] = await Promise.all([
      import('@modelcontextprotocol/sdk/server/index.js'),
      import('@modelcontextprotocol/sdk/types.js'),
    ]);
    return {
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
 * Create a transport-agnostic MCP Server exposing every GraphQL operation as a
 * tool. Requires the optional `@modelcontextprotocol/sdk` dependency.
 * @param {import('graphql').GraphQLSchema} schema
 * @param {Object} [options] same options as {@link generateMCPTools}, plus
 *   `serverName` and `serverVersion`.
 * @returns {Promise<Object>} an SDK Server instance (call `server.connect(transport)`)
 */
export const createMCPServer = async (schema, options = {}) => {
  const sdk = await loadSdkCore();
  const { tools, callTool } = generateMCPTools(schema, options);
  return newServerInstance(sdk, tools, callTool, options);
};

/**
 * Create an MCP Server and connect it over stdio. Use for a standalone MCP
 * executable (e.g. for Cursor / Claude Desktop).
 * @param {import('graphql').GraphQLSchema} schema
 * @param {Object} [options] same options as {@link createMCPServer}.
 * @returns {Promise<Object>} the connected SDK Server instance
 */
export const startStdioMCPServer = async (schema, options = {}) => {
  // Load the core first so a missing SDK reports MCP_SDK_NOT_INSTALLED, while a
  // present-but-old SDK missing the transport reports MCP_SDK_INCOMPATIBLE.
  const server = await createMCPServer(schema, options);

  let StdioServerTransport;
  try {
    ({ StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js'));
  } catch (err) {
    if (isModuleNotFound(err)) {
      throw sdkIncompatibleError('the stdio transport');
    }
    throw sdkLoadFailedError(err);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
};

/**
 * Create an Express-style request handler that serves the MCP over Streamable
 * HTTP, suitable for mounting next to the existing GraphQL endpoint. A fresh,
 * stateless server + transport pair is created per request.
 *
 * The tool definitions are built once; the execution context is resolved per
 * request. When `options.context` is a function it is invoked as
 * `(req, extra) => context` for every call, where `req` is the Express request,
 * enabling per-request authentication (e.g. reading an Authorization header).
 *
 * @param {import('graphql').GraphQLSchema} schema
 * @param {Object} [options] same options as {@link createMCPServer}; in HTTP mode
 *   a function `context` receives `(req, extra)`. Additionally:
 * @param {Object} [options.transportOptions] extra options passed to the SDK's
 *   StreamableHTTPServerTransport (e.g. `enableDnsRebindingProtection`,
 *   `allowedHosts`, `allowedOrigins` — recommended for localhost deployments).
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

  const { mode, execution } = resolveExecution(options.execution);
  if (mode === 'in-process') {
    applySchemaPlugins(schema, options.schemaPlugins);
  }
  const { tools, toolIndex } = buildToolDefinitions(schema, options);

  return async (req, res) => {
    try {
      const context = typeof options.context === 'function'
        ? (extra) => options.context(req, extra)
        : (options.context ?? {});
      const callTool = createCallTool({
        schema,
        toolIndex,
        mode,
        execution,
        context,
        limits: options.limits,
        toolMiddleware: options.toolMiddleware,
      });
      const server = newServerInstance(sdk, tools, callTool, options);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        ...(options.transportOptions || {}),
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
