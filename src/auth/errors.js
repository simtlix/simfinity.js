import SimfinityError from '../errors/simfinity.error.js';

/**
 * Authentication error - thrown when user is not authenticated
 * Uses code: UNAUTHENTICATED, status: 401
 */
export class UnauthenticatedError extends SimfinityError {
  constructor(message = 'Authentication required') {
    super(message, 'UNAUTHENTICATED', 401);
    this.name = 'UnauthenticatedError';
  }
}

/**
 * Authorization error - thrown when user lacks permission
 * Uses code: FORBIDDEN, status: 403
 */
export class ForbiddenError extends SimfinityError {
  constructor(message = 'Access denied') {
    super(message, 'FORBIDDEN', 403);
    this.name = 'ForbiddenError';
  }
}

/**
 * Generic auth error factory for custom auth failures
 * @param {string} message - Error message
 * @param {string} code - Error code (UNAUTHENTICATED or FORBIDDEN)
 * @returns {SimfinityError}
 */
export const createAuthError = (message, code = 'FORBIDDEN') => {
  const status = code === 'UNAUTHENTICATED' ? 401 : 403;
  return new SimfinityError(message, code, status);
};

// Export all errors as an object for convenience
const errors = {
  UnauthenticatedError,
  ForbiddenError,
  createAuthError,
};

export default errors;

