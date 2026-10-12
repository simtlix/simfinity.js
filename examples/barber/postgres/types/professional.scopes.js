import { scopeBarbershopRelationByRole } from './scopeHelpers.js';

/** Professionals scoped by barbershop ownership / approved shops. */
export function scopeProfessionalByRole(payload) {
  scopeBarbershopRelationByRole(payload);
}

export const professionalScopes = {
  find: scopeProfessionalByRole,
  aggregate: scopeProfessionalByRole,
  get_by_id: scopeProfessionalByRole,
};
