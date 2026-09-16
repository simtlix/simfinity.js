import * as simfinity from '@simtlix/simfinity-postgres';
import { isOwner, isPlatformAdmin, intersectScopeFilter, getBarbershopIdsForOwner } from './scopeHelpers.js';

/** Owner sees shop bookings or own client bookings; others only own client bookings. */
export async function scopeBookingByRole({ args, context }) {
  if (isPlatformAdmin(context)) return;
  if (isOwner(context)) {
    const BarbershopModel = simfinity.getModel(simfinity.getType('barbershop'));
    const shopIds = await getBarbershopIdsForOwner(BarbershopModel, context.user.id);
    intersectScopeFilter(args, 'OR', [
      { conditions: [{ field: 'barbershop', path: 'id', operator: 'IN', value: shopIds }] },
      { conditions: [{ field: 'client', path: 'id', operator: 'EQ', value: context.user.id }] },
    ]);
    return;
  }
  intersectScopeFilter(args, 'client', {
    terms: [{ path: 'id', operator: 'EQ', value: context?.user?.id ?? '00000000-0000-0000-0000-000000000000' }],
  });
}

export const bookingScopes = {
  find: scopeBookingByRole,
  aggregate: scopeBookingByRole,
  get_by_id: scopeBookingByRole,
};
