import { denyAnonymousByIdTerms, isPlatformAdmin, scopeRootIdToUser } from './scopeHelpers.js';

/** Non-admins only see their own user row; anonymous gets zero-match id filter. */
export async function scopeUserByRole({ args, context }) {
  if (isPlatformAdmin(context)) return;
  if (!context?.user?.id) {
    denyAnonymousByIdTerms(args);
    return;
  }
  scopeRootIdToUser(args, context.user.id);
}

export const userScopes = {
  find: scopeUserByRole,
  aggregate: scopeUserByRole,
  get_by_id: scopeUserByRole,
};
