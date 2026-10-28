import { SimfinityError } from '@simtlix/simfinity-core';
import { LEGACY_QUERY_OPERATORS } from '@simtlix/simfinity-core/internal/query-operators';

const invalid = (message) => { throw new SimfinityError(message, 'INVALID_SQL_PLUGIN', 400); };
const methods = {
  naming: ['validateIdentifier', 'generatedName'],
  values: ['createId', 'castId', 'encodeScalar', 'decodeScalar', 'encodeEmbedded'],
  driver: ['assertConfiguration', 'query', 'acquire', 'begin', 'commit', 'rollback', 'release', 'isRetryable', 'normalizeError'],
};

/** Bind immutable contract members while retaining caller-owned connection objects. */
export const bindPlugin = (plugin) => {
  if (!plugin || typeof plugin !== 'object') invalid('A SQL plugin is required');
  if (plugin.apiVersion !== 1) {
    if (plugin.apiVersion == null) invalid('SQL plugin apiVersion is required');
    throw new SimfinityError('Unsupported SQL plugin contract version', 'UNSUPPORTED_SQL_PLUGIN_VERSION', 400);
  }
  for (const key of ['name', 'displayName', 'defaultSchema']) {
    if (typeof plugin[key] !== 'string' || !plugin[key].length) invalid(`SQL plugin ${key} must be a nonempty string`);
  }
  if (!Array.isArray(plugin.capabilities) || plugin.capabilities.some((value) => typeof value !== 'string')) invalid('SQL plugin capabilities must be strings');
  if (plugin.options != null && (typeof plugin.options !== 'object' || Array.isArray(plugin.options))) invalid('SQL plugin options must be an object or null');
  const bound = { apiVersion: 1, name: plugin.name, displayName: plugin.displayName, defaultSchema: plugin.defaultSchema,
    options: plugin.options == null ? null : Object.freeze({ ...plugin.options }), capabilities: Object.freeze([...plugin.capabilities]) };
  for (const key of ['describeSchema', 'initialize', 'compileSchema', 'compileQuery', 'compileRecord']) {
    if (typeof plugin[key] !== 'function') invalid(`SQL plugin ${key} must be a function`);
    bound[key] = plugin[key];
  }
  // Optional batched children reads (findChildrenBatch). The compiler names, as its `compileQuery` property, the
  // compileQuery whose per-parent statements it reproduces, and is bound only when that is the bound compileQuery:
  // a plugin copy that overrides compileQuery, or a compiler that names none, reads each parent with compileQuery.
  if (plugin.compileChildrenQuery !== undefined) {
    if (typeof plugin.compileChildrenQuery !== 'function') invalid('SQL plugin compileChildrenQuery must be a function');
    if (plugin.compileChildrenQuery.compileQuery === bound.compileQuery) bound.compileChildrenQuery = plugin.compileChildrenQuery;
  }
  // Optional multi-row inserts of owned rows: records batch them only when both members are present.
  if (plugin.compileRecordBatch !== undefined) {
    if (typeof plugin.compileRecordBatch !== 'function') invalid('SQL plugin compileRecordBatch must be a function');
    bound.compileRecordBatch = plugin.compileRecordBatch;
  }
  if (plugin.maxRecordBatchValues !== undefined) {
    if (!Number.isSafeInteger(plugin.maxRecordBatchValues) || plugin.maxRecordBatchValues < 1) invalid('SQL plugin maxRecordBatchValues must be a positive safe integer');
    bound.maxRecordBatchValues = plugin.maxRecordBatchValues;
  }
  // Optional query language features: the QLOperator values compileQuery compiles, an omitted operator's EQ
  // included. A plugin without them compiles the operators of 3.7.0, so the runtime and the adapter's query plans
  // reject the others with UNSUPPORTED_QUERY before they reach compileQuery. Names Simfinity does not know are kept
  // and ignored. Like compileChildrenQuery, a declaration may name, as its `compileQuery`, the compileQuery it
  // describes, and then holds only for that one: a copy such as { ...postgresPlugin(options), compileQuery } inherits
  // the bundled declaration, which does not describe its compiler, and compiles the operators of 3.7.0 until it
  // declares its own. A declaration that names none describes the plugin's compileQuery, whichever it is.
  // `referenceEmptiness: true` (#108 part 2b) says that compileQuery compiles emptiness predicates that cross or end at
  // references and collections, and the `scopes` of client constructs; it is copied under the same rule, and only
  // when true. `quantifiers` additionally declares collection/reference frames and requires referenceEmptiness;
  // valuePath declares validated field operands and also requires referenceEmptiness. Both declarations follow
  // the same compiler identity rule. Each omitted flag stays absent in the bound
  // declaration, and the adapter rejects requests for that feature. Undefined and null mean false.
  const { queryFeatures } = plugin;
  if (queryFeatures != null && (typeof queryFeatures !== 'object' || Array.isArray(queryFeatures)
    || !Array.isArray(queryFeatures.operators) || queryFeatures.operators.some((value) => typeof value !== 'string'))) {
    invalid('SQL plugin queryFeatures must be an object whose operators are strings');
  }
  if (queryFeatures?.compileQuery !== undefined && typeof queryFeatures.compileQuery !== 'function') {
    invalid('SQL plugin queryFeatures.compileQuery must be a function');
  }
  if (queryFeatures?.referenceEmptiness != null && typeof queryFeatures.referenceEmptiness !== 'boolean') {
    invalid('SQL plugin queryFeatures.referenceEmptiness must be a boolean');
  }
  if (queryFeatures?.quantifiers != null && typeof queryFeatures.quantifiers !== 'boolean') {
    invalid('SQL plugin queryFeatures.quantifiers must be a boolean');
  }
  if (queryFeatures?.valuePath != null && typeof queryFeatures.valuePath !== 'boolean') {
    invalid('SQL plugin queryFeatures.valuePath must be a boolean');
  }
  if (queryFeatures?.valuePath === true && queryFeatures.referenceEmptiness !== true) {
    invalid('SQL plugin queryFeatures.valuePath requires referenceEmptiness');
  }
  if (queryFeatures?.quantifiers === true && queryFeatures.referenceEmptiness !== true) {
    invalid('SQL plugin queryFeatures.quantifiers requires referenceEmptiness');
  }
  if (queryFeatures?.elementFrames != null && typeof queryFeatures.elementFrames !== 'boolean') invalid('SQL plugin queryFeatures.elementFrames must be a boolean');
  if (queryFeatures?.elementFrames === true && (queryFeatures.referenceEmptiness !== true || queryFeatures.quantifiers !== true || queryFeatures.valuePath !== true)) {
    invalid('SQL plugin queryFeatures.elementFrames requires quantifiers, referenceEmptiness and valuePath');
  }
  const declared = queryFeatures != null && (queryFeatures.compileQuery === undefined || queryFeatures.compileQuery === bound.compileQuery);
  bound.queryFeatures = Object.freeze({
    operators: Object.freeze([...(declared ? queryFeatures.operators : LEGACY_QUERY_OPERATORS)]),
    ...(declared && queryFeatures.referenceEmptiness === true ? { referenceEmptiness: true } : {}),
    ...(declared && queryFeatures.quantifiers === true ? { quantifiers: true } : {}),
    ...(declared && queryFeatures.valuePath === true ? { valuePath: true } : {}),
    ...(declared && queryFeatures.elementFrames === true ? { elementFrames: true } : {}),
  });
  for (const [group, names] of Object.entries(methods)) {
    const members = {};
    for (const key of names) {
      if (typeof plugin[group]?.[key] !== 'function') invalid(`SQL plugin ${group}.${key} must be a function`);
      members[key] = plugin[group][key];
    }
    bound[group] = Object.freeze(members);
  }
  return Object.freeze(bound);
};

// Protected entities add optimisticConcurrency to their plan. Declaring it commits compileRecord to
// conditional updates (including empty data) and deletes, with returned rows and numeric Version decoding.
export const assertCapabilities = (plugin, plan) => {
  for (const capability of new Set(['transactions', ...plan.requirements])) {
    if (!plugin.capabilities.includes(capability)) throw new SimfinityError(`SQL plugin ${plugin.name} does not support required capability ${capability}`, 'UNSUPPORTED_SQL_CAPABILITY', 400);
  }
};
