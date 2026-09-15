import * as simfinity from '@simtlix/simfinity-js';
import { scopeBarbershopRelationByRole } from './scopeHelpers.js';

/** Service catalog scoped by barbershop ownership / approved shops. */
export async function scopeServiceByRole(payload) {
  await scopeBarbershopRelationByRole(simfinity, payload);
}

export const serviceScopes = {
  find: scopeServiceByRole,
  aggregate: scopeServiceByRole,
  get_by_id: scopeServiceByRole,
};
