import {
  denyAnonymousByIdTerms,
  isPlatformAdmin,
  scopeRelationToUser,
} from './scopeHelpers.js';

/** Favorites: admin all; signed-in user only own; anonymous zero-match. */
export async function scopeFavoriteByRole({ args, context }) {
  if (isPlatformAdmin(context)) return;
  if (!context?.user?.id) {
    denyAnonymousByIdTerms(args);
    return;
  }
  scopeRelationToUser(args, context.user.id, 'user');
}

export const favoriteScopes = {
  find: scopeFavoriteByRole,
  aggregate: scopeFavoriteByRole,
  get_by_id: scopeFavoriteByRole,
};
