/**
 * Declarations for `@simtlix/simfinity-core/auth/rules`. Every member has the type of the same
 * member of the root `auth` namespace, so the two cannot drift.
 */
import { auth } from '../index.js';

export type { AuthRuleFunction } from '../index.js';
export const resolvePath: typeof auth.resolvePath;
export const requireAuth: typeof auth.requireAuth;
export const requireRole: typeof auth.requireRole;
export const requirePermission: typeof auth.requirePermission;
export const composeRules: typeof auth.composeRules;
export const anyRule: typeof auth.anyRule;
export const isOwner: typeof auth.isOwner;
export const createRule: typeof auth.createRule;
export const allow: typeof auth.allow;
export const deny: typeof auth.deny;

declare const rules: Pick<typeof auth,
  | 'resolvePath'
  | 'requireAuth'
  | 'requireRole'
  | 'requirePermission'
  | 'composeRules'
  | 'anyRule'
  | 'isOwner'
  | 'createRule'
  | 'allow'
  | 'deny'>;
export default rules;
