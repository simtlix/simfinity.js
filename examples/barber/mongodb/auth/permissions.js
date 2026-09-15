/**
 * GraphQL Envelop auth rules (createAuthPlugin).
 *
 * Layer 1 — RBAC + optional resource checks (async rules, e.g. barbershop owner by id).
 * Layer 2 — controllers / scopes: remaining field rules (see types/*.js).
 *
 * Mutation keys MUST match the schema exactly (run schema introspection if Simfinity changes names).
 */
import * as simfinity from '@simtlix/simfinity-js';

const { composeRules, requireAuth } = simfinity.auth;

export function hasAnyRole(ctx, roleNames) {
  const roles = ctx?.user?.roles;
  if (!Array.isArray(roles)) return false;
  return roleNames.some((r) => roles.includes(r));
}

export function requirePlatformAdmin() {
  return composeRules(
    requireAuth(),
    (_parent, _args, ctx) => {
      if (!hasAnyRole(ctx, ['PLATFORM_ADMIN'])) {
        throw new simfinity.auth.ForbiddenError('Requires platform admin');
      }
    },
  );
}

export function requireOwnerOrPlatformAdmin() {
  return composeRules(
    requireAuth(),
    (_parent, _args, ctx) => {
      if (!hasAnyRole(ctx, ['OWNER', 'PLATFORM_ADMIN'])) {
        throw new simfinity.auth.ForbiddenError('Requires owner or platform admin');
      }
    },
  );
}

/**
 * Resolves barbershop id from Simfinity mutation args (`deletebarbershop(id)` vs `updatebarbershop(input: { id })`).
 * @param {Record<string, unknown>} args
 */
export function barbershopIdFromArgs(args) {
  if (!args || typeof args !== 'object') return null;
  if (args.id != null) return String(args.id);
  const input = args.input;
  if (input && typeof input === 'object' && input.id != null) return String(input.id);
  return null;
}

/**
 * PLATFORM_ADMIN: allow. OWNER: must own the barbershop (loads document by id). Others: forbidden.
 * Use for update/delete/transition mutations that target a specific barbershop record.
 */
export function requireOwnerOrAdminForBarbershopResource() {
  return composeRules(
    requireAuth(),
    async (_parent, args, ctx) => {
      if (hasAnyRole(ctx, ['PLATFORM_ADMIN'])) return;
      if (!hasAnyRole(ctx, ['OWNER'])) {
        throw new simfinity.auth.ForbiddenError('Requires owner or platform admin');
      }
      const barbershopId = barbershopIdFromArgs(args);
      if (!barbershopId) {
        throw new simfinity.auth.ForbiddenError('Missing barbershop id');
      }
      const BarbershopModel = simfinity.getModel(simfinity.getType('barbershop'));
      const existing = await BarbershopModel.findById(barbershopId).select('owner').lean();
      if (!existing || String(existing.owner) !== String(ctx.user.id)) {
        throw new simfinity.auth.ForbiddenError('You can only modify your own barbershops');
      }
    },
  );
}

/**
 * `owner` is required on input (NonNull on barbershop type). PLATFORM_ADMIN may set any owner;
 * OWNER may only set themselves as owner.
 */
export function requireOwnerOrAdminForAddBarbershop() {
  return composeRules(
    requireAuth(),
    (_parent, args, ctx) => {
      if (!hasAnyRole(ctx, ['OWNER', 'PLATFORM_ADMIN'])) {
        throw new simfinity.auth.ForbiddenError('Requires owner or platform admin');
      }
      if (hasAnyRole(ctx, ['PLATFORM_ADMIN'])) return;
      const input = args?.input;
      const ownerPayload = input?.owner;
      const ownerId =
        ownerPayload && typeof ownerPayload === 'object' && ownerPayload.id != null
          ? String(ownerPayload.id)
          : ownerPayload != null
            ? String(ownerPayload)
            : null;
      if (!ownerId || ownerId !== String(ctx.user.id)) {
        throw new simfinity.auth.ForbiddenError('Owners can only create barbershops for themselves');
      }
    },
  );
}

const requireAuthenticated = () => requireAuth();

export const permissions = {
  Mutation: {
    // Barbershop — admin-only transitions
    approve_barbershop: requirePlatformAdmin(),
    reject_barbershop: requirePlatformAdmin(),
    suspend_barbershop: requirePlatformAdmin(),
    reactivate_barbershop: requirePlatformAdmin(),

    // Barbershop — add: owner required in schema; OWNER restricted to self via rule below
    addbarbershop: requireOwnerOrAdminForAddBarbershop(),
    updatebarbershop: requireOwnerOrAdminForBarbershopResource(),
    deletebarbershop: requireOwnerOrAdminForBarbershopResource(),
    submitforreview_barbershop: requireOwnerOrAdminForBarbershopResource(),
    resubmit_barbershop: requireOwnerOrAdminForBarbershopResource(),

    // Shop-scoped entities — owner / admin
    addservice: requireOwnerOrPlatformAdmin(),
    updateservice: requireOwnerOrPlatformAdmin(),
    deleteservice: requireOwnerOrPlatformAdmin(),

    addprofessional: requireOwnerOrPlatformAdmin(),
    updateprofessional: requireOwnerOrPlatformAdmin(),
    deleteprofessional: requireOwnerOrPlatformAdmin(),

    addserviceCategory: requireOwnerOrPlatformAdmin(),
    updateserviceCategory: requireOwnerOrPlatformAdmin(),
    deleteserviceCategory: requireOwnerOrPlatformAdmin(),

    addbundle: requireOwnerOrPlatformAdmin(),
    updatebundle: requireOwnerOrPlatformAdmin(),
    deletebundle: requireOwnerOrPlatformAdmin(),

    // Bookings — authenticated clients; shop actions restricted to owner/admin
    addbooking: requireAuthenticated(),
    updatebooking: requireAuthenticated(),
    deletebooking: requireAuthenticated(),
    cancelbyclient_booking: requireAuthenticated(),
    cancelbyshop_booking: requireOwnerOrPlatformAdmin(),
    complete_booking: requireOwnerOrPlatformAdmin(),
    noshow_booking: requireOwnerOrPlatformAdmin(),

    // Favorites — signed-in users only
    addfavorite: requireAuthenticated(),
    updatefavorite: requireAuthenticated(),
    deletefavorite: requireAuthenticated(),

    // Reviews — signed-in users (scopes/controllers refine further)
    addreview: requireAuthenticated(),
    updatereview: requireAuthenticated(),
    deletereview: requireAuthenticated(),

    // Notifications & preferences — own data via scopes and ownership controllers
    addnotification: requireAuthenticated(),
    updatenotification: requireAuthenticated(),
    deletenotification: requireAuthenticated(),
    addnotificationPreference: requireAuthenticated(),
    updatenotificationPreference: requireAuthenticated(),
    deletenotificationPreference: requireAuthenticated(),

    // Users — admin creates/deletes; updates require login (ownership controller limits self-service)
    adduser: requirePlatformAdmin(),
    deleteuser: requirePlatformAdmin(),
    updateuser: requireAuthenticated(),
  },
};
