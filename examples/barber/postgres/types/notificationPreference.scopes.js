import {
  denyAnonymousByIdTerms,
  isPlatformAdmin,
  scopeRelationToUser,
} from './scopeHelpers.js';

/** Preferences: admin all; signed-in user only own; anonymous zero-match. */
export async function scopeNotificationPreferenceByRole({ args, context }) {
  if (isPlatformAdmin(context)) return;
  if (!context?.user?.id) {
    denyAnonymousByIdTerms(args);
    return;
  }
  scopeRelationToUser(args, context.user.id, 'user');
}

export const notificationPreferenceScopes = {
  find: scopeNotificationPreferenceByRole,
  aggregate: scopeNotificationPreferenceByRole,
  get_by_id: scopeNotificationPreferenceByRole,
};
