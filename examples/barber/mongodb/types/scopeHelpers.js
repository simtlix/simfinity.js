/** Mongo ObjectId string that matches no real document (anonymous / deny scope). */
export const ZERO_MATCH_OBJECT_ID = '000000000000000000000000';

/** @param {unknown} context */
export function isPlatformAdmin(context) {
  return Boolean(context?.user?.roles?.includes('PLATFORM_ADMIN'));
}

/** @param {unknown} context */
export function isOwner(context) {
  return Boolean(context?.user?.roles?.includes('OWNER'));
}

/** Intersect server restrictions with existing caller filters, including OR groups. */
export function intersectScopeFilter(args, field, restriction) {
  if (args[field] == null) {
    args[field] = restriction;
    return;
  }
  const group = field === 'OR'
    ? { OR: restriction }
    : { conditions: restriction.terms
      ? restriction.terms.map((term) => ({ field, ...term }))
      : [{ field, ...restriction }] };
  args.AND = [...(args.AND || []), group];
}

/** Sets `args.id` to a zero-match filter so queries return no rows. */
export function denyAnonymousByIdTerms(args) {
  intersectScopeFilter(args, 'id', { operator: 'EQ', value: ZERO_MATCH_OBJECT_ID });
}

/**
 * Scopes root entity by `args.id` to the signed-in user's id (scalar filter).
 * @param {Record<string, unknown>} args
 * @param {string} userId
 */
export function scopeRootIdToUser(args, userId) {
  intersectScopeFilter(args, 'id', { operator: 'EQ', value: userId });
}

/**
 * Scopes a relation field on `args` to a single user id.
 * @param {Record<string, unknown>} args
 * @param {string} userId
 * @param {string} [field='user']
 */
export function scopeRelationToUser(args, userId, field = 'user') {
  intersectScopeFilter(args, field, { terms: [{ path: 'id', operator: 'EQ', value: userId }] });
}

/**
 * Catalog entities under barbershop: admin sees all; owner sees owned shops; others approved shops only.
 * The restriction is a path through the `barbershop` relation, so the database applies it in the same
 * query that reads the entity. Simfinity runs scopes once per parent row and once per resolved
 * reference, so a scope must not load barbershop IDs itself.
 * @param {{ args: Record<string, unknown>, context: unknown }} payload
 */
export function scopeBarbershopRelationByRole({ args, context }) {
  if (isPlatformAdmin(context)) return;
  intersectScopeFilter(args, 'barbershop', {
    terms: [isOwner(context) ? ownedBarbershopTerm(context) : approvedBarbershopTerm()],
  });
}

/**
 * Term on the `barbershop` relation for shops owned by the signed-in user (a fresh object per call).
 * @param {{ user: { id: string } }} context
 */
export function ownedBarbershopTerm(context) {
  return { path: 'owner.id', operator: 'EQ', value: context.user.id };
}

/** Term on the `barbershop` relation for APPROVED shops (a fresh object per call). */
export function approvedBarbershopTerm() {
  return { path: 'state', operator: 'EQ', value: 'APPROVED' };
}
