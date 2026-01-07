/**
 * Simfinity GraphQL Authorization Middleware
 * 
 * Production-grade centralized GraphQL authorization supporting:
 * - RBAC / ABAC
 * - Function-based rules
 * - Declarative policy expressions (JSON AST)
 * - Wildcard "*" permissions
 * - Default allow/deny policies
 * 
 * @example
 * import { auth } from '@simtlix/simfinity-js';
 * import { applyMiddleware } from 'graphql-middleware';
 * 
 * const { createAuthMiddleware, requireAuth, requireRole } = auth;
 * 
 * const permissions = {
 *   Query: {
 *     users: requireAuth(),
 *     adminDashboard: requireRole('ADMIN')
 *   },
 *   Mutation: {
 *     publishPost: requireRole('EDITOR')
 *   },
 *   User: {
 *     '*': requireAuth(),
 *     email: requireRole('ADMIN')
 *   }
 * };
 * 
 * const authMiddleware = createAuthMiddleware(permissions, { defaultPolicy: 'DENY' });
 * const schemaWithAuth = applyMiddleware(schema, authMiddleware);
 */

import { UnauthenticatedError, ForbiddenError, createAuthError } from './errors.js';
import { isPolicyExpression, createRuleFromExpression, evaluateExpression } from './expressions.js';
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

// Re-export errors
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
 * @typedef {Object|RuleFunction|Array<RuleFunction>} Rule
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
    return rule.flatMap(r => normalizeRule(r));
  }
  
  if (isPolicyExpression(rule)) {
    return [createRuleFromExpression(rule)];
  }
  
  // Unknown rule type - return empty (will use default policy)
  return [];
};

/**
 * Gets the rule for a specific field, with wildcard fallback
 * @param {PermissionSchema} permissions - The permission schema
 * @param {string} typeName - The GraphQL type name
 * @param {string} fieldName - The field name
 * @returns {Function[]|null} Array of rule functions or null if no rule found
 */
const getFieldRules = (permissions, typeName, fieldName) => {
  const typePerms = permissions[typeName];
  
  if (!typePerms) {
    return null;
  }
  
  // Check for exact field rule first
  if (fieldName in typePerms) {
    return normalizeRule(typePerms[fieldName]);
  }
  
  // Fallback to wildcard
  if ('*' in typePerms) {
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
 * Creates a graphql-middleware compatible authorization middleware
 * 
 * @param {PermissionSchema} permissions - The permission schema object
 * @param {AuthMiddlewareOptions} [options={}] - Middleware options
 * @returns {Function} A graphql-middleware compatible middleware function
 * 
 * @example
 * const permissions = {
 *   Query: {
 *     users: requireAuth(),
 *     adminDashboard: requireRole('ADMIN')
 *   },
 *   User: {
 *     '*': requireAuth(),
 *     email: requireRole('ADMIN')
 *   },
 *   Post: {
 *     content: {
 *       anyOf: [
 *         { eq: [{ ref: 'parent.published' }, true] },
 *         { eq: [{ ref: 'parent.authorId' }, { ref: 'ctx.user.id' }] }
 *       ]
 *     }
 *   }
 * };
 * 
 * const middleware = createAuthMiddleware(permissions, { defaultPolicy: 'DENY' });
 */
export const createAuthMiddleware = (permissions, options = {}) => {
  const {
    defaultPolicy = 'DENY',
    debug = false,
  } = options;

  const log = debug ? console.log.bind(console, '[auth]') : () => {};

  /**
   * The middleware generator function
   * Returns a middleware object keyed by type name, each containing field resolvers
   */
  return async (resolve, parent, args, ctx, info) => {
    const typeName = info.parentType.name;
    const fieldName = info.fieldName;

    log(`Checking ${typeName}.${fieldName}`);

    // Get rules for this field
    const rules = getFieldRules(permissions, typeName, fieldName);

    // If no rules found, apply default policy
    if (rules === null || rules.length === 0) {
      log(`No rules for ${typeName}.${fieldName}, applying default policy: ${defaultPolicy}`);
      
      if (defaultPolicy === 'DENY') {
        throw new ForbiddenError(`Access denied to ${typeName}.${fieldName}`);
      }
      
      // ALLOW - proceed to resolver
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

    log(`Access granted to ${typeName}.${fieldName}`);
    
    // All rules passed - proceed to resolver
    return resolve(parent, args, ctx, info);
  };
};

/**
 * Creates a field-level middleware object from a permission schema
 * This can be used with graphql-middleware's applyMiddleware
 * 
 * @param {PermissionSchema} permissions - The permission schema
 * @param {AuthMiddlewareOptions} [options={}] - Middleware options
 * @returns {Object} Field middleware object compatible with graphql-middleware
 */
export const createFieldMiddleware = (permissions, options = {}) => {
  const middleware = createAuthMiddleware(permissions, options);
  const fieldMiddleware = {};

  for (const typeName of Object.keys(permissions)) {
    fieldMiddleware[typeName] = {};
    
    const typePerms = permissions[typeName];
    for (const fieldName of Object.keys(typePerms)) {
      if (fieldName === '*') {
        // Wildcard rules are handled by the middleware internally
        continue;
      }
      fieldMiddleware[typeName][fieldName] = middleware;
    }
  }

  return fieldMiddleware;
};

// Default export with all auth utilities
const auth = {
  // Main factory
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

