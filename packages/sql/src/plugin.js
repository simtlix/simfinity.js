import { SimfinityError } from '@simtlix/simfinity-core';

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

export const assertCapabilities = (plugin, plan) => {
  for (const capability of new Set(['transactions', ...plan.requirements])) {
    if (!plugin.capabilities.includes(capability)) throw new SimfinityError(`SQL plugin ${plugin.name} does not support required capability ${capability}`, 'UNSUPPORTED_SQL_CAPABILITY', 400);
  }
};
