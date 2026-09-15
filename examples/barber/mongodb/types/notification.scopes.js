import {
  denyAnonymousByIdTerms,
  isPlatformAdmin,
  scopeRelationToUser,
} from './scopeHelpers.js';

/** Notifications: admin all; signed-in user only own; anonymous zero-match. */
export async function scopeNotificationByRole({ args, context }) {
  if (isPlatformAdmin(context)) return;
  if (!context?.user?.id) {
    denyAnonymousByIdTerms(args);
    return;
  }
  scopeRelationToUser(args, context.user.id, 'user');
}

export const notificationScopes = {
  find: scopeNotificationByRole,
  aggregate: scopeNotificationByRole,
  get_by_id: scopeNotificationByRole,
};
