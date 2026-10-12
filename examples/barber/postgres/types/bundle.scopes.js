import { scopeBarbershopRelationByRole } from './scopeHelpers.js';

/** Bundles scoped by barbershop ownership / approved shops. */
export function scopeBundleByRole(payload) {
  scopeBarbershopRelationByRole(payload);
}

export const bundleScopes = {
  find: scopeBundleByRole,
  aggregate: scopeBundleByRole,
  get_by_id: scopeBundleByRole,
};
