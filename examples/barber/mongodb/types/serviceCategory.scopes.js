import { scopeBarbershopRelationByRole } from './scopeHelpers.js';

/** Service categories scoped by barbershop ownership / approved shops. */
export function scopeServiceCategoryByRole(payload) {
  scopeBarbershopRelationByRole(payload);
}

export const serviceCategoryScopes = {
  find: scopeServiceCategoryByRole,
  aggregate: scopeServiceCategoryByRole,
  get_by_id: scopeServiceCategoryByRole,
};
