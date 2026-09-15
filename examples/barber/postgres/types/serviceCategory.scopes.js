import * as simfinity from '@simtlix/simfinity-postgres';
import { scopeBarbershopRelationByRole } from './scopeHelpers.js';

/** Service categories scoped by barbershop ownership / approved shops. */
export async function scopeServiceCategoryByRole(payload) {
  await scopeBarbershopRelationByRole(simfinity, payload);
}

export const serviceCategoryScopes = {
  find: scopeServiceCategoryByRole,
  aggregate: scopeServiceCategoryByRole,
  get_by_id: scopeServiceCategoryByRole,
};
