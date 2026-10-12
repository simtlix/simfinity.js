import { scopeBarbershopRelationByRole } from './scopeHelpers.js';

/** Service catalog scoped by barbershop ownership / approved shops. */
export function scopeServiceByRole(payload) {
  scopeBarbershopRelationByRole(payload);
}

export const serviceScopes = {
  find: scopeServiceByRole,
  aggregate: scopeServiceByRole,
  get_by_id: scopeServiceByRole,
};
