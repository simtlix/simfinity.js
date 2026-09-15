import * as simfinity from '@simtlix/simfinity-postgres';
import { scopeBarbershopRelationByRole } from './scopeHelpers.js';

/** Reviews scoped by barbershop ownership / approved shops. */
export async function scopeReviewByRole(payload) {
  await scopeBarbershopRelationByRole(simfinity, payload);
}

export const reviewScopes = {
  find: scopeReviewByRole,
  aggregate: scopeReviewByRole,
  get_by_id: scopeReviewByRole,
};
