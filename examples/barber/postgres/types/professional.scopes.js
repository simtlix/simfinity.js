import * as simfinity from '@simtlix/simfinity-postgres';
import { scopeBarbershopRelationByRole } from './scopeHelpers.js';

/** Professionals scoped by barbershop ownership / approved shops. */
export async function scopeProfessionalByRole(payload) {
  await scopeBarbershopRelationByRole(simfinity, payload);
}

export const professionalScopes = {
  find: scopeProfessionalByRole,
  aggregate: scopeProfessionalByRole,
  get_by_id: scopeProfessionalByRole,
};
