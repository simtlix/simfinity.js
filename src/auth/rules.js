import { UnauthenticatedError, ForbiddenError } from './errors.js';

/**
 * Resolves a value from an object using a dotted path string or function.
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
  return (_parent, _args, ctx) => {
    if (!ctx) {
      throw new UnauthenticatedError('You must be logged in to access this resource');
    }
    const user = resolvePath(ctx, userPath);
    if (!user) {
      throw new UnauthenticatedError('You must be logged in to access this resource');
    }
    return true;
  };
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
  const roles = Array.isArray(role) ? role : [role];
  const { userPath = 'user', rolePath = 'role' } = options;
  
  return (_parent, _args, ctx) => {
    if (!ctx) {
      throw new UnauthenticatedError('You must be logged in to access this resource');
    }
    const user = resolvePath(ctx, userPath);
    if (!user) {
      throw new UnauthenticatedError('You must be logged in to access this resource');
    }
    
    const userRole = resolvePath(user, rolePath);
    
    if (!roles.includes(userRole)) {
      throw new ForbiddenError(`Requires role: ${roles.join(' or ')}`);
    }
    
    return true;
  };
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
  const requiredPermissions = Array.isArray(permission) ? permission : [permission];
  const { userPath = 'user', permissionsPath = 'permissions' } = options;
  
  return (_parent, _args, ctx) => {
    if (!ctx) {
      throw new UnauthenticatedError('You must be logged in to access this resource');
    }
    const user = resolvePath(ctx, userPath);
    if (!user) {
      throw new UnauthenticatedError('You must be logged in to access this resource');
    }
    
    const userPermissions = resolvePath(user, permissionsPath) || [];
    
    // Check if user has wildcard permission
    if (userPermissions.includes('*')) {
      return true;
    }
    
    // All required permissions must be present
    for (const perm of requiredPermissions) {
      if (!userPermissions.includes(perm)) {
        throw new ForbiddenError(`Missing permission: ${perm}`);
      }
    }
    
    return true;
  };
};

/**
 * Composes multiple rules - all must pass (logical AND)
 * @param  {...Function} rules - Rule functions to compose
 * @returns {Function} Composed rule function
 */
export const composeRules = (...rules) => {
  return async (parent, args, ctx, info) => {
    for (const rule of rules) {
      const result = await rule(parent, args, ctx, info);
      // If rule returns false, deny access
      if (result === false) {
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
  return async (parent, args, ctx, info) => {
    let lastError = null;
    
    for (const rule of rules) {
      try {
        const result = await rule(parent, args, ctx, info);
        if (result !== false) {
          return true; // At least one rule passed
        }
      } catch (error) {
        lastError = error;
        // Continue to next rule
      }
    }
    
    // No rule passed - throw the last error or return false
    if (lastError) {
      throw lastError;
    }
    return false;
  };
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

  return (parent, _args, ctx) => {
    if (!ctx) {
      throw new UnauthenticatedError('You must be logged in to access this resource');
    }
    const user = resolvePath(ctx, userPath);
    if (!user) {
      throw new UnauthenticatedError('You must be logged in to access this resource');
    }

    // Get ownerId from parent (using path or function)
    const ownerId = resolvePath(parent, ownerField);

    // Get userId from user object (using path or function)
    const userId = resolvePath(user, userIdField);

    if (ownerId === undefined || userId === undefined) {
      return false;
    }

    return String(ownerId) === String(userId);
  };
};

/**
 * Creates a custom rule from a predicate function
 * @param {Function} predicate - Function (parent, args, ctx, info) => boolean | Promise<boolean>
 * @param {string} errorMessage - Error message if rule fails
 * @param {string} errorCode - Error code (FORBIDDEN or UNAUTHENTICATED)
 * @returns {Function} Rule function
 */
export const createRule = (predicate, errorMessage = 'Access denied', errorCode = 'FORBIDDEN') => {
  return async (parent, args, ctx, info) => {
    const result = await predicate(parent, args, ctx, info);
    
    if (result === false) {
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
  return () => {
    throw new ForbiddenError(message);
  };
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

