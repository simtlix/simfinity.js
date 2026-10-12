import { scopeBarbershopRelationByRole } from './scopeHelpers.js';

/** Reviews scoped by barbershop ownership / approved shops. */
export function scopeReviewByRole(payload) {
  scopeBarbershopRelationByRole(payload);
}

export const reviewScopes = {
  find: scopeReviewByRole,
  aggregate: scopeReviewByRole,
  get_by_id: scopeReviewByRole,
};
