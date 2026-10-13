import {
  approvedBarbershopTerm, intersectScopeFilter, isOwner, isPlatformAdmin, ownedBarbershopTerm,
} from './scopeHelpers.js';

// The helpers build terms on a `barbershop` relation; on the barbershop itself, a term's path is the field.
const onBarbershop = ({ path, ...term }) => ({ field: path, ...term });

/**
 * Anonymous users and clients see APPROVED barbershops only. Owners see the same public shops plus
 * their own in any state, so another owner's DRAFT, PENDING_REVIEW, REJECTED or SUSPENDED shop stays
 * hidden from lists, reads by ID and aggregates. Platform admins see every shop.
 */
export function scopeBarbershopByRole({ args, context }) {
  if (isPlatformAdmin(context)) return;
  if (isOwner(context)) {
    intersectScopeFilter(args, 'OR', [
      { conditions: [onBarbershop(approvedBarbershopTerm())] },
      { conditions: [onBarbershop(ownedBarbershopTerm(context))] },
    ]);
    return;
  }
  intersectScopeFilter(args, 'state', { operator: 'EQ', value: 'APPROVED' });
}

export const barbershopScopes = {
  find: scopeBarbershopByRole,
  aggregate: scopeBarbershopByRole,
  get_by_id: scopeBarbershopByRole,
};
