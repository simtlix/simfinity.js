/** Nil UUID that matches no real document (anonymous / deny scope). */
export const ZERO_MATCH_OBJECT_ID = '00000000-0000-0000-0000-000000000000';

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
 * Scopes root entity by `args.id` to the signed-in user's id (terms filter).
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
 * @param {typeof import('@simtlix/simfinity-postgres')} simfinity
 * @param {{ args: Record<string, unknown>, context: unknown }} payload
 */
export async function scopeBarbershopRelationByRole(simfinity, { args, context }) {
  if (isPlatformAdmin(context)) return;
  const BarbershopModel = simfinity.getModel(simfinity.getType('barbershop'));
  if (isOwner(context)) {
    const ids = await getBarbershopIdsForOwner(BarbershopModel, context.user.id);
    intersectScopeFilter(args, 'barbershop', { terms: [{ path: 'id', operator: 'IN', value: ids.map(String) }] });
    return;
  }
  await scopeToApprovedBarbershopsOnly(BarbershopModel, { args });
}

/**
 * @param {object} BarbershopModel
 * @param {string} ownerUserId
 * @returns {Promise<string[]>}
 */
export async function getBarbershopIdsForOwner(BarbershopModel, ownerUserId) {
  const rows = await findAll(BarbershopModel, { owner: { terms: [{ path: 'id', operator: 'EQ', value: ownerUserId }] } });
  return rows.map((r) => r._id);
}

/**
 * @param {object} BarbershopModel
 * @returns {Promise<string[]>}
 */
export async function getApprovedBarbershopIds(BarbershopModel) {
  const rows = await findAll(BarbershopModel, { state: { operator: 'EQ', value: 'APPROVED' } });
  return rows.map((r) => String(r._id));
}

/**
 * Catalog / discovery: limit child entities to approved barbershops (anonymous + clients).
 * @param {object} BarbershopModel
 * @param {{ args: Record<string, unknown> }} param1
 */
export async function scopeToApprovedBarbershopsOnly(BarbershopModel, { args }) {
  const ids = await getApprovedBarbershopIds(BarbershopModel);
  intersectScopeFilter(args, 'barbershop', { terms: [{ path: 'id', operator: 'IN', value: ids }] });
}

/** Page native queries explicitly: the runtime defaults to 100 rows. */
export async function findAll(model, args, session) {
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const page = await model.find({ ...args, pagination: { page: offset / 100 + 1, size: 100 } }, { session });
    rows.push(...page);
    if (page.length < 100) return rows;
  }
}
