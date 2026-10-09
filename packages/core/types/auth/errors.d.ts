/**
 * Declarations for `@simtlix/simfinity-core/auth/errors`. Every member has the type of the
 * same member of the root `auth` namespace, so the two cannot drift.
 */
import { auth } from '../index.js';

// The root classes themselves, which `auth.UnauthenticatedError` and `auth.ForbiddenError` also are.
export { UnauthenticatedError, ForbiddenError } from '../index.js';
export const createAuthError: typeof auth.createAuthError;

declare const errors: Pick<typeof auth, 'UnauthenticatedError' | 'ForbiddenError' | 'createAuthError'>;
export default errors;
