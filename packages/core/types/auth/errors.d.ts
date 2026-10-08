/**
 * Declarations for `@simtlix/simfinity-core/auth/errors`. Every member has the type of the
 * same member of the root `auth` namespace, so the two cannot drift.
 */
import { auth } from '../index.js';

/** Authentication error: code `UNAUTHENTICATED`, status 401. */
export const UnauthenticatedError: typeof auth.UnauthenticatedError;
export type UnauthenticatedError = InstanceType<typeof auth.UnauthenticatedError>;
/** Authorization error: code `FORBIDDEN`, status 403. */
export const ForbiddenError: typeof auth.ForbiddenError;
export type ForbiddenError = InstanceType<typeof auth.ForbiddenError>;
export const createAuthError: typeof auth.createAuthError;

declare const errors: Pick<typeof auth, 'UnauthenticatedError' | 'ForbiddenError' | 'createAuthError'>;
export default errors;
