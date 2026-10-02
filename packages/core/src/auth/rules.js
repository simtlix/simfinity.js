import { UnauthenticatedError, ForbiddenError } from './errors.js';
import { normalizeObjectId } from './object-id.js';
import { isThenable, discardThenable } from './thenable.js';

/**
 * Resolves a value from an object using a dotted path string or function.
 * A function's result is returned as is, including a promise; the built-in rules deny such results.
 * @param {Object} obj - The object to resolve from
 * @param {string|Function} pathOrFn - Dotted path (e.g., 'user.profile.id') or function to extract value
 * @returns {*} The resolved value or undefined if not found
 * @example
 * resolvePath({ user: { id: '123' } }, 'user.id') // returns '123'
 * resolvePath({ user: { id: '123' } }, (obj) => obj.user.id) // returns '123'
 */
export const resolvePath = (obj, pathOrFn) => {
  if (typeof pathOrFn === 'function') {
    return pathOrFn(obj);
  }
  if (typeof pathOrFn === 'string') {
    const parts = pathOrFn.split('.');
    let value = obj;
    for (const part of parts) {
      if (value == null) return undefined;
      value = value[part];
    }
    return value;
  }
  return undefined;
};

// Built-in rules also have a check that returns true, false or a factory for the denial error.
// anyRule uses it so a denial that a later rule overrides never builds and throws an error.
// Checks are keyed by the rule function itself: a property would be copied by Object.assign or
// read through a Proxy, and anyRule would then skip the checks of a wrapping function.
const checks = new WeakMap();

const ruleFromCheck = (check) => {
  const rule = (parent, args, ctx, info) => {
    const result = check(parent, args, ctx, info);
    if (typeof result === 'function') throw result();
    return result;
  };
  checks.set(rule, check);
  return rule;
};

const unauthenticated = () => new UnauthenticatedError('You must be logged in to access this resource');

// Built-in checks are synchronous, so they cannot wait for a path that yields a promise or another
// thenable. Such a value is never truthy evidence of a user or claim: it denies with this error.
const pendingValue = () => new TypeError(
  'Authorization paths must return values synchronously; resolve asynchronous data in the GraphQL context or use an async rule',
);
const pending = Symbol('pending authorization value');

const isAsyncFunction = value => ['[object AsyncFunction]', '[object AsyncGeneratorFunction]']
  .includes(Object.prototype.toString.call(value));

const validatePath = (name, pathOrFn) => {
  if (isAsyncFunction(pathOrFn)) {
    throw new TypeError(`${name} must be a dotted path or a synchronous extractor function`);
  }
};

/** Resolve a path for a built-in check; a thenable result is discarded and reported as pending. */
const readPath = (obj, pathOrFn) => {
  const value = resolvePath(obj, pathOrFn);
  if (!isThenable(value)) return value;
  discardThenable(value);
  return pending;
};

/**
 * Rule that requires the user to be authenticated
 * Checks for user existence at the specified path in context
 * @param {string|Function} [userPath='user'] - Path to user in context (e.g., 'user', 'auth.user', 'session.user')
 * @returns {Function} Rule function (parent, args, ctx, info) => boolean | throws
 * @example
 * requireAuth()                    // checks ctx.user
 * requireAuth('auth.user')         // checks ctx.auth.user
 * requireAuth('session.currentUser') // checks ctx.session.currentUser
 */
export const requireAuth = (userPath = 'user') => {
  validatePath('userPath', userPath);
  return ruleFromCheck((_parent, _args, ctx) => {
    if (!ctx) return unauthenticated;
    const user = readPath(ctx, userPath);
    if (user === pending) return pendingValue;
    return user ? true : unauthenticated;
  });
};

/**
 * Rule that requires the user to have a specific role
 * @param {string|string[]} role - Required role or array of roles (any match)
 * @param {Object} [options] - Configuration options
 * @param {string|Function} [options.userPath='user'] - Path to user in context
 * @param {string|Function} [options.rolePath='role'] - Path to role field in user object
 * @returns {Function} Rule function (parent, args, ctx, info) => boolean | throws
 * @example
 * requireRole('ADMIN')
 * requireRole(['ADMIN', 'EDITOR'])
 * requireRole('ADMIN', { userPath: 'auth.user', rolePath: 'roles.primary' })
 */
export const requireRole = (role, options = {}) => {
  // Copy the list, so changing the caller's array later cannot bypass this validation.
  const roles = Object.freeze(Array.isArray(role) ? Array.from(role) : [role]);
  if (roles.length === 0 || Array.from(roles).some(value => typeof value !== 'string' || value.length === 0)) {
    throw new TypeError('Required roles must be a nonempty string or array of nonempty strings');
  }
  const { userPath = 'user', rolePath = 'role' } = options;
  validatePath('userPath', userPath);
  validatePath('rolePath', rolePath);
  const forbidden = () => new ForbiddenError(`Requires role: ${roles.join(' or ')}`);

  return ruleFromCheck((_parent, _args, ctx) => {
    if (!ctx) return unauthenticated;
    const user = readPath(ctx, userPath);
    if (user === pending) return pendingValue;
    if (!user) return unauthenticated;

    const userRole = readPath(user, rolePath);
    if (userRole === pending) return pendingValue;
    return roles.includes(userRole) ? true : forbidden;
  });
};

/**
 * Validate the claims and find the required permissions they hold in one pass, without copying
 * them. Returns null for malformed claims (including holes) and true for a standalone '*' entry.
 * Nothing is cached: a context can outlive a request, and claims can change in place.
 */
const findHeldPermissions = (claims, requiredPermissions) => {
  if (!Array.isArray(claims)) return null;
  let wildcard = false;
  const held = new Set();
  for (let index = 0; index < claims.length; index++) {
    const claim = claims[index];
    if (typeof claim !== 'string' || claim.length === 0) return null;
    if (claim === '*') wildcard = true;
    else if (requiredPermissions.includes(claim)) held.add(claim);
  }
  return wildcard || held;
};

/**
 * Rule that requires the user to have a specific permission
 * @param {string|string[]} permission - Required permission(s) (all must match if array)
 * @param {Object} [options] - Configuration options
 * @param {string|Function} [options.userPath='user'] - Path to user in context
 * @param {string|Function} [options.permissionsPath='permissions'] - Path to permissions array in user object
 * @returns {Function} Rule function (parent, args, ctx, info) => boolean | throws
 * @example
 * requirePermission('posts:read')
 * requirePermission(['posts:read', 'posts:write'])
 * requirePermission('posts:read', { userPath: 'auth.user', permissionsPath: 'grants' })
 */
export const requirePermission = (permission, options = {}) => {
  // Copy the list, so changing the caller's array later cannot bypass this validation.
  const requiredPermissions = Object.freeze(Array.isArray(permission) ? Array.from(permission) : [permission]);
  if (requiredPermissions.length === 0
    || Array.from(requiredPermissions).some(perm => typeof perm !== 'string' || perm.length === 0)) {
    throw new TypeError('Required permissions must be a nonempty string or array of nonempty strings');
  }
  const { userPath = 'user', permissionsPath = 'permissions' } = options;
  validatePath('userPath', userPath);
  validatePath('permissionsPath', permissionsPath);

  return ruleFromCheck((_parent, _args, ctx) => {
    if (!ctx) return unauthenticated;
    const user = readPath(ctx, userPath);
    if (user === pending) return pendingValue;
    if (!user) return unauthenticated;

    const claims = readPath(user, permissionsPath);
    if (claims === pending) return pendingValue;
    const held = findHeldPermissions(claims, requiredPermissions);
    if (held === null) {
      return () => new ForbiddenError('User permissions must be an array of nonempty strings');
    }

    // A wildcard entry grants every permission
    if (held === true) {
      return true;
    }

    // All required permissions must be present
    const missing = requiredPermissions.find(perm => !held.has(perm));
    return missing === undefined ? true : () => new ForbiddenError(`Missing permission: ${missing}`);
  });
};

/**
 * Composes multiple rules - all must pass (logical AND)
 * @param  {...Function} rules - Rule functions to compose
 * @returns {Function} Composed rule function
 */
export const composeRules = (...rules) => {
  // With no rules the composition would grant everything; use allow() for an intentional grant.
  if (rules.length === 0) {
    throw new TypeError('composeRules requires at least one rule');
  }
  if (rules.some(rule => typeof rule !== 'function')) {
    throw new TypeError('composeRules requires rule functions');
  }
  return async (parent, args, ctx, info) => {
    for (const rule of rules) {
      const result = await rule(parent, args, ctx, info);
      // Only true or void grants access, consistently with direct rules.
      if (result !== true && result !== undefined) {
        return false;
      }
      // If rule throws, it will propagate
    }
    return true;
  };
};

/**
 * Creates a rule that allows access if ANY of the provided rules pass (logical OR)
 * @param  {...Function} rules - Rule functions to check
 * @returns {Function} Combined rule function
 */
export const anyRule = (...rules) => {
  if (rules.length === 0) {
    throw new TypeError('anyRule requires at least one rule');
  }
  if (rules.some(rule => typeof rule !== 'function')) {
    throw new TypeError('anyRule requires rule functions');
  }
  return async (parent, args, ctx, info) => {
    let lastError = null;
    // A built-in rule's denial is kept as a factory and only built if it is the error thrown.
    let lastErrorIsFactory = false;

    for (const rule of rules) {
      try {
        const check = checks.get(rule);
        const result = check ? check(parent, args, ctx, info) : await rule(parent, args, ctx, info);
        if (check && typeof result === 'function') {
          lastError = result;
          lastErrorIsFactory = true;
        } else if (result === true || result === undefined) {
          return true; // At least one rule passed
        }
      } catch (error) {
        lastError = error;
        lastErrorIsFactory = false;
        // Continue to next rule
      }
    }

    // No rule passed - throw the last error or return false
    if (lastErrorIsFactory) {
      throw lastError();
    }
    if (lastError) {
      throw lastError;
    }
    return false;
  };
};

const normalizeOwnerId = (value) => {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return normalizeObjectId(value);
};

/**
 * Creates a rule that checks if the authenticated user owns the resource
 * @param {string|Function} [ownerField='userId'] - Path to owner ID in parent, or function to extract it
 * @param {string|Function} [userIdField='id'] - Path to user ID in user object, or function to extract it
 * @param {Object} [options] - Configuration options
 * @param {string|Function} [options.userPath='user'] - Path to user in context
 * @returns {Function} Rule function
 * @example
 * isOwner()                                    // compares parent.userId with ctx.user.id
 * isOwner('authorId')                          // compares parent.authorId with ctx.user.id
 * isOwner('author.id', 'profile.id')           // compares parent.author.id with ctx.user.profile.id
 * isOwner('authorId', 'id', { userPath: 'auth.user' }) // uses ctx.auth.user instead of ctx.user
 */
export const isOwner = (ownerField = 'userId', userIdField = 'id', options = {}) => {
  const { userPath = 'user' } = options;
  validatePath('ownerField', ownerField);
  validatePath('userIdField', userIdField);
  validatePath('userPath', userPath);

  return ruleFromCheck((parent, _args, ctx) => {
    if (!ctx) return unauthenticated;
    const user = readPath(ctx, userPath);
    if (user === pending) return pendingValue;
    if (!user) return unauthenticated;

    // Get ownerId from parent (using path or function)
    const owner = readPath(parent, ownerField);
    // Get userId from user object (using path or function)
    const id = readPath(user, userIdField);
    if (owner === pending || id === pending) return pendingValue;
    const ownerId = normalizeOwnerId(owner);
    const userId = normalizeOwnerId(id);

    if (ownerId === undefined || userId === undefined) {
      return false;
    }

    return ownerId === userId;
  });
};

/**
 * Creates a custom rule from a predicate function
 * @param {Function} predicate - Function returning true/void to allow, or throwing to deny
 * @param {string} errorMessage - Error message if rule fails
 * @param {string} errorCode - Error code (FORBIDDEN or UNAUTHENTICATED)
 * @returns {Function} Rule function
 */
export const createRule = (predicate, errorMessage = 'Access denied', errorCode = 'FORBIDDEN') => {
  if (typeof predicate !== 'function') {
    throw new TypeError('createRule requires a predicate function');
  }
  return async (parent, args, ctx, info) => {
    const result = await predicate(parent, args, ctx, info);

    if (result !== true && result !== undefined) {
      if (errorCode === 'UNAUTHENTICATED') {
        throw new UnauthenticatedError(errorMessage);
      }
      throw new ForbiddenError(errorMessage);
    }

    return true;
  };
};

/**
 * Rule that always allows access (useful for public fields)
 * @returns {Function} Rule function that always returns true
 */
export const allow = () => {
  return () => true;
};

/**
 * Rule that always denies access
 * @param {string} message - Optional denial message
 * @returns {Function} Rule function that always throws ForbiddenError
 */
export const deny = (message = 'Access denied') => {
  const forbidden = () => new ForbiddenError(message);
  return ruleFromCheck(() => forbidden);
};

// Export all rules as an object for convenience
const rules = {
  // Utility
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
};

export default rules;
