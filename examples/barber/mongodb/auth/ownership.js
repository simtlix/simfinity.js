import * as simfinity from '@simtlix/simfinity-js';

const model = (name) => simfinity.getModel(simfinity.getType(name));
const forbidden = () => { throw new simfinity.auth.ForbiddenError('You cannot modify this resource'); };
const hasRole = (context, role) => context?.user?.roles?.includes(role);
// ObjectId.id is a Buffer; normalize it before reading document-shaped IDs.
const reference = (value) => value?.toHexString?.() ?? String(value?._id ?? value?.id ?? value);
const own = (value, context) => reference(value) === context?.user?.id;
const shopEntities = ['service', 'serviceCategory', 'professional', 'bundle'];

async function ownsShop(id, session, context) {
  if (!id || !hasRole(context, 'OWNER')) return false;
  const shop = await model('barbershop').findById(reference(id)).session(session);
  return shop && own(shop.owner, context);
}

async function check(name, doc, changes, session, context, operation) {
  if (!context?.user) forbidden();
  const admin = hasRole(context, 'PLATFORM_ADMIN');
  if (name === 'user') {
    if (!admin && (operation !== 'update' || !own(doc, context))) forbidden();
    if (!admin && ['role', 'emailVerified', 'status', 'passwordHash'].some((key) => key in changes || key in (changes.$unset || {}))) forbidden();
    return;
  }
  if (name === 'barbershop') {
    if (!admin && (!hasRole(context, 'OWNER') || !own(doc.owner, context))) forbidden();
    const values = changes.toObject?.() ?? changes;
    if (!admin && ['averageRating', 'reviewCount'].some((key) => Object.hasOwn(values, key) || Object.hasOwn(values.$unset || {}, key))) forbidden();
    return;
  }
  if (shopEntities.includes(name)) {
    if (!admin && !await ownsShop(doc.barbershop, session, context)) forbidden();
    if (!admin && changes.barbershop && !await ownsShop(changes.barbershop, session, context)) forbidden();
    return;
  }
  if (name === 'booking') {
    const shopOwner = await ownsShop(doc.barbershop, session, context);
    if (!admin && !own(doc.client, context) && !shopOwner && operation !== 'create') forbidden();
    if (!admin && operation === 'create' && changes.client && !own(changes.client, context) && !shopOwner) forbidden();
    if (!admin && operation === 'update') {
      if (changes.state && ['COMPLETED', 'CANCELLED_BY_SHOP', 'NO_SHOW'].includes(changes.state) && !shopOwner) forbidden();
      if (changes.state === 'CANCELLED_BY_CLIENT' && !own(doc.client, context)) forbidden();
      if (changes.client && !own(changes.client, context) && !shopOwner) forbidden();
      if (changes.barbershop && reference(changes.barbershop) !== reference(doc.barbershop)) forbidden();
    }
    return;
  }
  if (name === 'review') {
    if (changes.rating != null && (!Number.isInteger(changes.rating) || changes.rating < 1 || changes.rating > 5)) throw new Error('Rating must be between 1 and 5');
    if (!admin && !own(doc.client, context)) {
      if (operation !== 'update' || !await ownsShop(doc.barbershop, session, context) || Object.keys(changes).some((key) => !['reply', 'id'].includes(key))) forbidden();
    }
    if (!admin && changes.client && !own(changes.client, context)) forbidden();
    if (operation === 'update' && ('barbershop' in (changes.$unset || {}) || ('barbershop' in changes && reference(changes.barbershop) !== reference(doc.barbershop)))) forbidden();
    return;
  }
  if (['favorite', 'notification', 'notificationPreference'].includes(name)) {
    if (!admin && (!own(doc.user, context) || (changes.user && !own(changes.user, context)))) forbidden();
  }
}

/** Controllers guard root and nested writes inside their active transaction. */
export function protect(name, controller = {}) {
  return {
    ...controller,
    async onSaving(doc, args, session, context) {
      await check(name, doc, doc, session, context, 'create');
      await controller.onSaving?.(doc, args, session, context);
    },
    async onUpdating(id, changes, session, context) {
      const doc = await model(name).findById(id).session(session);
      if (!doc) forbidden();
      await check(name, doc, changes, session, context, 'update');
      await controller.onUpdating?.(id, changes, session, context);
    },
    async onDelete(doc, session, context) {
      if (!doc) forbidden();
      await check(name, doc, {}, session, context, 'delete');
      await controller.onDelete?.(doc, session, context);
    },
  };
}
