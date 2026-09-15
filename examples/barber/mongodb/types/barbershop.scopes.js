import { isOwner, isPlatformAdmin } from './scopeHelpers.js';

/** Restricts non-admin non-owner queries to APPROVED barbershops only. */
export async function scopeBarbershopByRole({ args, context }) {
  if (isPlatformAdmin(context)) return;
  if (isOwner(context)) return;
  args.state = { operator: 'EQ', value: 'APPROVED' };
}

export const barbershopScopes = {
  find: scopeBarbershopByRole,
  aggregate: scopeBarbershopByRole,
  get_by_id: scopeBarbershopByRole,
};
