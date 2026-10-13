import { isOwner, isPlatformAdmin, intersectScopeFilter, ownedBarbershopTerm } from './scopeHelpers.js';

/**
 * Owner sees shop bookings or own client bookings; others only own client bookings.
 * The owner branch restricts through the `barbershop` relation instead of loading shop IDs per call.
 */
export function scopeBookingByRole({ args, context }) {
  if (isPlatformAdmin(context)) return;
  if (isOwner(context)) {
    intersectScopeFilter(args, 'OR', [
      { conditions: [{ field: 'barbershop', ...ownedBarbershopTerm(context) }] },
      { conditions: [{ field: 'client', path: 'id', operator: 'EQ', value: context.user.id }] },
    ]);
    return;
  }
  intersectScopeFilter(args, 'client', {
    terms: [{ path: 'id', operator: 'EQ', value: context?.user?.id ?? '000000000000000000000000' }],
  });
}

export const bookingScopes = {
  find: scopeBookingByRole,
  aggregate: scopeBookingByRole,
  get_by_id: scopeBookingByRole,
};
