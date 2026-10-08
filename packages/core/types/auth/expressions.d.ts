/**
 * Declarations for `@simtlix/simfinity-core/auth/expressions`. Every named export has the type of
 * the same member of the root `auth` namespace, so the two cannot drift.
 */
import { auth } from '../index.js';

export type { PolicyExpression } from '../index.js';
export const evaluateExpression: typeof auth.evaluateExpression;
export const isPolicyExpression: typeof auth.isPolicyExpression;
export const createRuleFromExpression: typeof auth.createRuleFromExpression;

declare const expressions: Pick<typeof auth, 'evaluateExpression' | 'isPolicyExpression' | 'createRuleFromExpression'> & {
  /**
   * Low-level helper kept on the default object only: reads a dotted `parent.`, `args.` or `ctx.`
   * path from `{ parent, args, ctx }`; an invalid path gives `undefined`. Prefer
   * `createRuleFromExpression`.
   */
  resolveRef(refPath: string, context: any): unknown;
  /**
   * Low-level helper kept on the default object only: resolves a `{ ref }` operand, or returns a
   * literal as is.
   */
  resolveValue(value: unknown, context: any): unknown;
};
export default expressions;
