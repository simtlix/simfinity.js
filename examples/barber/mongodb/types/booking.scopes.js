import * as simfinity from '@simtlix/simfinity-js';
import { isOwner, isPlatformAdmin } from './scopeHelpers.js';

/** Owner sees shop bookings or own client bookings; others only own client bookings. */
export async function scopeBookingByRole({ args, context }) {
  if (isPlatformAdmin(context)) return;
  if (isOwner(context)) {
    const BarbershopModel = simfinity.getModel(simfinity.getType('barbershop'));
    const ids = await BarbershopModel.find({ owner: context.user.id }).select('_id').lean();
    const shopIds = ids.map((r) => String(r._id));
    args.OR = [
      { conditions: [{ field: 'barbershop', path: 'id', operator: 'IN', value: shopIds }] },
      { conditions: [{ field: 'client', path: 'id', operator: 'EQ', value: context.user.id }] },
    ];
    return;
  }
  args.client = {
    terms: [{ path: 'id', operator: 'EQ', value: context?.user?.id ?? '000000000000000000000000' }],
  };
}

export const bookingScopes = {
  find: scopeBookingByRole,
  aggregate: scopeBookingByRole,
  get_by_id: scopeBookingByRole,
};
