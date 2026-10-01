/**
 * Simfinity GraphQL Authorization
 *
 * Production-grade centralized GraphQL authorization supporting:
 * - RBAC / ABAC
 * - Function-based rules
 * - Declarative policy expressions (JSON AST)
 * - Wildcard "*" permissions
 * - Default allow/deny policies
 *
 * @example
 * import { createAuthPlugin, requireAuth, requireRole } from '@simtlix/simfinity-core/auth';
 * import { createYoga } from 'graphql-yoga';
 *
 * // Simfinity names its roots `RootQueryType` and `Mutation`.
 * const permissions = {
 *   RootQueryType: {
 *     series: requireAuth(),
 *     seasons: requireAuth(),
 *   },
 *   Mutation: {
 *     deleteserie: requireRole('admin'),
 *     deletestar: requireRole('admin'),
 *   },
 *   serie: {
 *     '*': requireAuth(),
 *   }
 * };
 *
 * const authPlugin = createAuthPlugin(permissions, { defaultPolicy: 'ALLOW' });
 * const yoga = createYoga({ schema, plugins: [authPlugin] });
 */

import { GraphQLError, GraphQLObjectType, defaultFieldResolver, __Field } from 'graphql';
import SimfinityError from '../errors/simfinity.error.js';
import { UnauthenticatedError, ForbiddenError, createAuthError } from './errors.js';
import { isPolicyExpression, createRuleFromExpression, evaluateExpression } from './expressions.js';
import { collectQueryPaths, walkQueryPath } from '../query-plan.js';
import {
  resolvePath,
  requireAuth,
  requireRole,
  requirePermission,
  composeRules,
  anyRule,
  isOwner,
  createRule,
  allow,
  deny,
} from './rules.js';

// Re-export shared errors
export { UnauthenticatedError, ForbiddenError, createAuthError } from './errors.js';

// Re-export expression utilities
export { evaluateExpression, isPolicyExpression, createRuleFromExpression } from './expressions.js';

// Re-export rule helpers and utilities
export {
  resolvePath,
  requireAuth,
  requireRole,
  requirePermission,
  composeRules,
  anyRule,
  isOwner,
  createRule,
  allow,
  deny,
} from './rules.js';

/**
 * @typedef {'ALLOW' | 'DENY'} DefaultPolicy
 */

/**
 * @typedef {Object} AuthMiddlewareOptions
 * @property {DefaultPolicy} [defaultPolicy='DENY'] - Default policy when no rule matches
 * @property {boolean} [debug=false] - Enable debug logging
 */

/**
 * @typedef {Function} RuleFunction
 * @param {*} parent - Parent resolver result
 * @param {Object} args - GraphQL arguments
 * @param {Object} ctx - GraphQL context
 * @param {Object} info - GraphQL resolve info
 * @returns {boolean|void|Promise<boolean|void>} - true/void to allow, false to deny
 */

/**
 * @typedef {boolean|Object|RuleFunction|Array<Rule>} Rule
 */

/**
 * @typedef {Object.<string, Rule>} TypePermissions
 */

/**
 * @typedef {Object.<string, TypePermissions>} PermissionSchema
 */

/**
 * Normalizes a rule to always be an array of functions
 * @param {Rule} rule - The rule to normalize
 * @returns {Function[]} Array of rule functions
 */
const normalizeRule = (rule) => {
  if (typeof rule === 'function') {
    return [rule];
  }

  if (Array.isArray(rule)) {
    if (rule.length === 0 || Array.from(rule).some(r => r === undefined)) {
      throw new TypeError('Authorization rule arrays must contain valid rules');
    }
    return rule.flatMap(r => normalizeRule(r));
  }

  if (isPolicyExpression(rule)) {
    return [createRuleFromExpression(rule)];
  }

  throw new TypeError('Invalid authorization rule: expected a function, nonempty rule array, or policy expression');
};

const isPermissionMap = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/**
 * Simfinity adds an `extensions` field to introspection's `__Field`. Its object types are shared by
 * every schema in the process and describe the schema itself, so authorization skips them like
 * `__` types unless the permission map names them. They are matched by identity.
 */
const isSimfinityMetadataType = (type) => {
  const extensionsType = __Field.getFields().extensions?.type;
  if (!(extensionsType instanceof GraphQLObjectType)) return false;
  return type === extensionsType || type === extensionsType.getFields().relation?.type;
};

const isExemptMetadataType = (permissions, type) => isSimfinityMetadataType(type)
  && !Object.hasOwn(permissions, type.name);

// Schemas processed by any auth plugin instance. A wrapper defers to the other instances only in
// these schemas; in a schema no instance processed, every wrapper keeps enforcing its rules.
const authorizedSchemas = new WeakSet();

const isThenable = value => value !== null && (typeof value === 'object' || typeof value === 'function')
  && typeof value.then === 'function';

const validateConfiguration = (permissions, defaultPolicy) => {
  if (defaultPolicy !== 'ALLOW' && defaultPolicy !== 'DENY') {
    throw new TypeError('defaultPolicy must be ALLOW or DENY');
  }
  if (!isPermissionMap(permissions)) {
    throw new TypeError('Authorization permissions must be an object');
  }
  for (const [typeName, typePermissions] of Object.entries(permissions)) {
    if (!isPermissionMap(typePermissions)) {
      throw new TypeError(`Permissions for ${typeName} must be an object`);
    }
    for (const [fieldName, rule] of Object.entries(typePermissions)) {
      try {
        normalizeRule(rule);
      } catch (error) {
        throw new TypeError(`Invalid authorization rule for ${typeName}.${fieldName}: ${error.message}`);
      }
    }
  }
};

/**
 * Gets the rule for a specific field, with wildcard fallback
 * @param {PermissionSchema} permissions - The permission schema
 * @param {string} typeName - The GraphQL type name
 * @param {string} fieldName - The field name
 * @returns {Function[]|null} Array of rule functions or null if no rule found
 */
const getFieldRules = (permissions, typeName, fieldName) => {
  if (!Object.hasOwn(permissions, typeName)) return null;
  const typePerms = permissions[typeName];
  if (!isPermissionMap(typePerms)) {
    throw new TypeError(`Permissions for ${typeName} must be an object`);
  }

  // Check for exact field rule first
  if (Object.hasOwn(typePerms, fieldName)) {
    return normalizeRule(typePerms[fieldName]);
  }

  // Fallback to wildcard
  if (Object.hasOwn(typePerms, '*')) {
    return normalizeRule(typePerms['*']);
  }

  return null;
};

/**
 * Executes a single rule
 * @param {Function} rule - The rule function to execute
 * @param {*} parent - Parent resolver result
 * @param {Object} args - GraphQL arguments
 * @param {Object} ctx - GraphQL context
 * @param {Object} info - GraphQL resolve info
 * @returns {Promise<boolean>} True if allowed, false if denied
 */
const executeRule = async (rule, parent, args, ctx, info) => {
  const result = await rule(parent, args, ctx, info);

  // void/undefined/true means allow
  if (result === undefined || result === true) {
    return true;
  }

  // false means deny
  return false;
};

/**
 * Applies read rules to the paths a client names in a generated list, aggregate or collection
 * field's filter, sort and aggregation arguments. Each segment needs its own `Type.field` rule
 * (exact, wildcard, then default policy). Rules run without a parent, with empty args and the
 * path field's identity in info, so parent-dependent rules such as isOwner deny query paths. A rule that
 * throws anything other than a Simfinity or GraphQL error denies the path.
 */
const authorizeQueryPaths = async (permissions, defaultPolicy, schema, query, args, ctx, info) => {
  const queriedType = query && schema?.getType?.(query.typeName);
  if (!queriedType) return;
  const checked = new Set();
  for (const segments of collectQueryPaths(args, query.operation)) {
    const steps = [];
    walkQueryPath(queriedType, segments, (step) => steps.push(step));
    for (const { type, fieldName, field } of steps) {
      const key = `${type.name}.${fieldName}`;
      if (checked.has(key)) continue;
      checked.add(key);
      const rules = getFieldRules(permissions, type.name, fieldName);
      if (rules === null) {
        if (defaultPolicy === 'DENY') throw new ForbiddenError(`Access denied to ${key}`);
        continue;
      }
      // The operation and response location belong to the invoking query, but permissions must
      // see the identity of the path field, just as when that field is selected directly.
      const fieldInfo = { ...info, fieldName, parentType: type, returnType: field.type };
      for (const rule of rules) {
        let allowed;
        try {
          allowed = await executeRule(rule, undefined, {}, ctx, fieldInfo);
        } catch (error) {
          if (error instanceof SimfinityError || error instanceof GraphQLError) throw error;
          allowed = false;
        }
        if (!allowed) throw new ForbiddenError(`Access denied to ${key}`);
      }
    }
  }
};

/**
 * Creates a graphql-middleware compatible authorization middleware.
 *
 * @deprecated Use {@link createAuthPlugin} instead. `applyMiddleware` from graphql-middleware
 * can cause duplicate-type errors when the schema contains custom introspection extensions.
 *
 * @param {PermissionSchema} permissions - The permission schema object
 * @param {AuthMiddlewareOptions} [options={}] - Middleware options
 * @returns {Function} A graphql-middleware compatible middleware function
 */
export const createAuthMiddleware = (permissions, options = {}) => {
  const {
    defaultPolicy = 'DENY',
    debug = false,
  } = options;

  validateConfiguration(permissions, defaultPolicy);

  const log = debug ? console.log.bind(console, '[auth]') : () => {};

  /**
   * The middleware generator function
   * Returns a middleware object keyed by type name, each containing field resolvers
   */
  return async (resolve, parent, args, ctx, info) => {
    if (isExemptMetadataType(permissions, info.parentType)) return resolve(parent, args, ctx, info);
    const typeName = info.parentType.name;
    const fieldName = info.fieldName;

    log(`Checking ${typeName}.${fieldName}`);

    // Get rules for this field
    const rules = getFieldRules(permissions, typeName, fieldName);
    const query = info.parentType?.getFields?.()[fieldName]?.extensions?.simfinityQuery;

    // If no rules found, apply default policy
    if (rules === null) {
      log(`No rules for ${typeName}.${fieldName}, applying default policy: ${defaultPolicy}`);

      if (defaultPolicy === 'DENY') {
        throw new ForbiddenError(`Access denied to ${typeName}.${fieldName}`);
      }

      // ALLOW - proceed to resolver
      await authorizeQueryPaths(permissions, defaultPolicy, info.schema, query, args, ctx, info);
      return resolve(parent, args, ctx, info);
    }

    // Execute all rules (AND logic - all must pass)
    for (const rule of rules) {
      log(`Executing rule for ${typeName}.${fieldName}`);

      const allowed = await executeRule(rule, parent, args, ctx, info);

      if (!allowed) {
        log(`Rule denied access to ${typeName}.${fieldName}`);
        throw new ForbiddenError(`Access denied to ${typeName}.${fieldName}`);
      }
    }

    await authorizeQueryPaths(permissions, defaultPolicy, info.schema, query, args, ctx, info);
    log(`Access granted to ${typeName}.${fieldName}`);

    // All rules passed - proceed to resolver
    return resolve(parent, args, ctx, info);
  };
};

/**
 * Creates graphql-middleware authorization for every object field of a schema.
 *
 * It returns the same function as {@link createAuthMiddleware}. graphql-middleware applies a
 * function middleware to every field, so `'*'` rules and the default policy also apply to fields
 * the permission map does not name. A map of only the named fields would leave the others open.
 *
 * @deprecated Use {@link createAuthPlugin} instead. `applyMiddleware` from graphql-middleware
 * can cause duplicate-type errors when the schema contains custom introspection extensions.
 *
 * @param {PermissionSchema} permissions - The permission schema
 * @param {AuthMiddlewareOptions} [options={}] - Middleware options
 * @returns {Function} A graphql-middleware compatible middleware function
 */
export const createFieldMiddleware = (permissions, options = {}) => createAuthMiddleware(permissions, options);

/**
 * Creates an Envelop-compatible authorization plugin that wraps schema resolvers in-place.
 *
 * Unlike {@link createAuthMiddleware} (which requires graphql-middleware's `applyMiddleware`
 * and rebuilds the schema), this plugin mutates resolvers directly on the existing schema,
 * avoiding schema reconstruction and the duplicate-type errors it can cause.
 *
 * @param {PermissionSchema} permissions - The permission schema object
 * @param {AuthMiddlewareOptions} [options={}] - Plugin options
 * @returns {Object} An Envelop plugin with an `onSchemaChange` hook
 *
 * @example
 * import { createAuthPlugin, requireAuth, requireRole } from '@simtlix/simfinity-core/auth';
 * import { createYoga } from 'graphql-yoga';
 *
 * // Keys are the schema's type names: Simfinity names its query root `RootQueryType`.
 * const permissions = {
 *   RootQueryType: {
 *     series: requireAuth(),
 *     serie: requireAuth(),
 *   },
 *   Mutation: {
 *     deleteserie: requireRole('ADMIN'),
 *   },
 *   serie: {
 *     '*': requireAuth(),
 *     budget: requireRole('ADMIN'),
 *   },
 * };
 *
 * const authPlugin = createAuthPlugin(permissions, { defaultPolicy: 'DENY' });
 * const yoga = createYoga({ schema, plugins: [authPlugin] });
 */
export const createAuthPlugin = (permissions, options = {}) => {
  const {
    defaultPolicy = 'DENY',
    debug = false,
  } = options;

  validateConfiguration(permissions, defaultPolicy);

  const log = debug ? console.log.bind(console, '[auth]') : () => {};
  const processedSchemas = new WeakSet();
  // Schemas built from the same types share their field objects, so each field is wrapped once.
  const wrappers = new WeakMap();
  let warnedAboutQueryRoot = false;

  const warnAboutQueryRoot = (schema) => {
    if (warnedAboutQueryRoot || !Object.hasOwn(permissions, 'Query') || schema.getType('Query')) return;
    const queryRoot = schema.getQueryType()?.name;
    if (!queryRoot) return;
    warnedAboutQueryRoot = true;
    console.warn(`[auth] Permissions for type "Query" match no type in the schema. Its query root is named "${queryRoot}"; did you mean "${queryRoot}"?`);
  };

  const createFieldResolver = (schema, typeName, fieldName, rules, query, originalResolve) => {
    const key = `${typeName}.${fieldName}`;
    const denied = () => Promise.reject(new ForbiddenError(`Access denied to ${key}`));

    // Errors keep reaching GraphQL as rejections, as they did when the whole check was async.
    const resolveField = (parent, args, ctx, info) => {
      try {
        return originalResolve(parent, args, ctx, info);
      } catch (error) {
        return Promise.reject(error);
      }
    };

    const grant = (parent, args, ctx, info) => {
      if (!query) return resolveField(parent, args, ctx, info);
      return authorizeQueryPaths(permissions, defaultPolicy, info?.schema ?? schema, query, args, ctx, info)
        .then(() => resolveField(parent, args, ctx, info));
    };

    // Rules run in order and synchronously until one returns a promise.
    const runRules = (index, parent, args, ctx, info) => {
      for (let current = index; current < rules.length; current++) {
        if (debug) log(`Executing rule for ${key}`);
        let result;
        try {
          result = rules[current](parent, args, ctx, info);
        } catch (error) {
          return Promise.reject(error);
        }
        if (isThenable(result)) {
          return Promise.resolve(result).then(value => (
            value === true || value === undefined ? runRules(current + 1, parent, args, ctx, info) : deny()
          ));
        }
        if (result !== true && result !== undefined) return deny();
      }
      if (debug) log(`Access granted to ${key}`);
      return grant(parent, args, ctx, info);
    };

    const deny = () => {
      if (debug) log(`Rule denied access to ${key}`);
      return denied();
    };

    return (parent, args, ctx, info) => {
      // In a schema that only other auth plugin instances processed, their rules apply, not these.
      if (info?.schema && authorizedSchemas.has(info.schema) && !processedSchemas.has(info.schema)) {
        return originalResolve(parent, args, ctx, info);
      }
      if (debug) log(`Checking ${key}`);

      if (rules === null) {
        if (debug) log(`No rules for ${key}, applying default policy: ${defaultPolicy}`);
        return defaultPolicy === 'DENY' ? denied() : grant(parent, args, ctx, info);
      }
      return runRules(0, parent, args, ctx, info);
    };
  };

  const wrapSchemaResolvers = (schema) => {
    if (processedSchemas.has(schema)) return;
    validateConfiguration(permissions, defaultPolicy);
    warnAboutQueryRoot(schema);

    const typeMap = schema.getTypeMap();

    for (const [typeName, type] of Object.entries(typeMap)) {
      if (!(type instanceof GraphQLObjectType) || typeName.startsWith('__') || isExemptMetadataType(permissions, type)) continue;

      const fields = type.getFields();

      for (const [fieldName, field] of Object.entries(fields)) {
        // Skip fields this plugin already wraps; a resolver replaced since then is wrapped again.
        const wrapper = wrappers.get(field);
        if (wrapper !== undefined && wrapper === field.resolve) continue;

        const rules = getFieldRules(permissions, typeName, fieldName);
        const query = field.extensions?.simfinityQuery;
        // An allowed field with no rule and no client query paths has nothing to check.
        if (rules === null && defaultPolicy === 'ALLOW' && !query && !debug) continue;

        const resolver = createFieldResolver(schema, typeName, fieldName, rules, query, field.resolve || defaultFieldResolver);
        field.resolve = resolver;
        wrappers.set(field, resolver);
      }
    }

    processedSchemas.add(schema);
    authorizedSchemas.add(schema);
  };

  return {
    onSchemaChange({ schema }) {
      wrapSchemaResolvers(schema);
    },
  };
};

// Default export with all auth utilities
const auth = {
  // Main factories
  createAuthPlugin,
  createAuthMiddleware,
  createFieldMiddleware,

  // Utilities
  resolvePath,

  // Rule helpers
  requireAuth,
  requireRole,
  requirePermission,
  composeRules,
  anyRule,
  isOwner,
  createRule,
  allow,
  deny,

  // Expression utilities
  evaluateExpression,
  isPolicyExpression,
  createRuleFromExpression,

  // Errors
  UnauthenticatedError,
  ForbiddenError,
  createAuthError,
};

export default auth;
