/**
 * Declarations for `@simtlix/simfinity-core/auth`. The default export is the root `auth`
 * namespace, and every named export has the type of the same member, so the two cannot drift.
 */
import { auth } from '../index.js';

export type {
  AuthPluginOptions,
  AuthRule,
  AuthRuleFunction,
  EnvelopSchemaPlugin,
  PermissionSchema,
  PolicyExpression,
  TypePermissions,
} from '../index.js';
export { UnauthenticatedError, ForbiddenError, createAuthError } from './errors.js';
export { evaluateExpression, isPolicyExpression, createRuleFromExpression } from './expressions.js';
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
export const createAuthPlugin: typeof auth.createAuthPlugin;
/** @deprecated Use createAuthPlugin instead. graphql-middleware compatible middleware. */
export const createAuthMiddleware: typeof auth.createAuthMiddleware;
/** @deprecated Use createAuthPlugin instead. The same function as createAuthMiddleware. */
export const createFieldMiddleware: typeof auth.createFieldMiddleware;

export default auth;
