import * as simfinity from '@simtlix/simfinity-js';
import { scopeBarbershopRelationByRole } from './scopeHelpers.js';

/** Bundles scoped by barbershop ownership / approved shops. */
export async function scopeBundleByRole(payload) {
  await scopeBarbershopRelationByRole(simfinity, payload);
}

export const bundleScopes = {
  find: scopeBundleByRole,
  aggregate: scopeBundleByRole,
  get_by_id: scopeBundleByRole,
};
