import * as simfinity from '@simtlix/simfinity-js';

const model = (name) => simfinity.getModel(simfinity.getType(name));
const forbidden = () => { throw new simfinity.auth.ForbiddenError('You cannot modify this resource'); };
// The same code on both backends; PostgreSQL's foreign keys would refuse these deletes anyway.
const inUse = (message) => { throw new simfinity.SimfinityError(message, 'RESOURCE_IN_USE', 409); };
const hasRole = (context, role) => context?.user?.roles?.includes(role);
// ObjectId.id is a Buffer; normalize it before reading document-shaped IDs.
const reference = (value) => value?.toHexString?.() ?? String(value?._id ?? value?.id ?? value);
const own = (value, context) => reference(value) === context?.user?.id;
const shopEntities = ['service', 'serviceCategory', 'professional', 'bundle'];
/** Whether an update clears a field that has a stored value (GraphQL `null` arrives as `$unset`). */
const clears = (changes, doc, key) => Object.hasOwn(changes.$unset || {}, key) && doc[key] != null;

/**
 * Fields a write changes. Edit forms resend unchanged values, so a create writes every field it gives
 * a value, and an update writes a field only when it sets another value than the stored one or clears
 * a stored value. Creates pass a Mongoose document, whose fields `toObject()` lists.
 */
function writtenFields(changes, doc, operation) {
  const values = changes.toObject?.() ?? changes;
  const written = new Set(Object.keys(values.$unset || {}).filter((key) => clears(values, doc, key)));
  for (const [key, value] of Object.entries(values)) {
    if (['$unset', 'id', '_id'].includes(key) || value == null) continue;
    const stored = operation === 'create' ? null : doc[key];
    if (stored == null || reference(value) !== reference(stored)) written.add(key);
  }
  return written;
}

/**
 * Whether a `name` record references the deleted record `doc` through `field`. MongoDB has no foreign
 * keys, so without this check a delete would leave those records pointing at nothing.
 */
async function referenced(name, field, doc, session) {
  return Boolean(await model(name).exists({ [field]: doc._id ?? doc.id }).session(session));
}

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
    // A shop keeps its bookings and reviews, so their history and ratings stay readable.
    if (!admin && operation === 'delete' && (await referenced('booking', 'barbershop', doc, session) || await referenced('review', 'barbershop', doc, session))) {
      inUse('This barbershop has bookings or reviews; it cannot be deleted');
    }
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
    // Clients cancel their bookings instead of deleting them; only the shop's owner or an admin deletes one.
    if (!admin && operation === 'delete' && !shopOwner) forbidden();
    // A review keeps the booking it reviews.
    if (!admin && operation === 'delete' && await referenced('review', 'booking', doc, session)) inUse('A review references this booking; it cannot be deleted');
    // Every booking keeps its shop: nobody clears it, and only an admin moves it to another shop.
    if (operation === 'update' && clears(changes, doc, 'barbershop')) forbidden();
    if (!admin && operation === 'update') {
      // A client changes only its confirmed bookings, notes included; completed and cancelled ones
      // are history that only the shop's owner or an admin edits.
      if (!shopOwner && doc.state !== 'CONFIRMED') forbidden();
      if (changes.state && ['COMPLETED', 'CANCELLED_BY_SHOP', 'NO_SHOW'].includes(changes.state) && !shopOwner) forbidden();
      if (changes.state === 'CANCELLED_BY_CLIENT' && !own(doc.client, context)) forbidden();
      if (changes.client && !own(changes.client, context) && !shopOwner) forbidden();
      // Only the shop's owner turns a booking into a walk-in without a client.
      if (clears(changes, doc, 'client') && !shopOwner) forbidden();
      if (changes.barbershop && reference(changes.barbershop) !== reference(doc.barbershop)) forbidden();
    }
    return;
  }
  if (name === 'review') {
    if (changes.rating != null && (!Number.isInteger(changes.rating) || changes.rating < 1 || changes.rating > 5)) throw new Error('Rating must be between 1 and 5');
    // Only moderation removes a review, so an author cannot delete a flagged or answered review and post it again.
    if (!admin && operation === 'delete') forbidden();
    const written = writtenFields(changes, doc, operation);
    if (!admin && own(doc.client, context)) {
      // Authors write the rating and comment; the reply and the moderation flag belong to the shop's owner.
      if (written.has('reply') || written.has('isReported')) forbidden();
      // The review controller checks the reviewed booking on create, so it stays fixed afterwards.
      if (operation === 'update' && written.has('booking')) forbidden();
    } else if (!admin) {
      // The shop's owner replies, withdraws the reply and flags the review; only an admin clears a flag.
      const ownerWrites = (key) => key === 'reply' || (key === 'isReported' && changes.isReported === true);
      if (operation !== 'update' || !await ownsShop(doc.barbershop, session, context) || [...written].some((key) => !ownerWrites(key))) forbidden();
    }
    if (!admin && written.has('client') && !own(changes.client, context)) forbidden();
    if (operation === 'update' && written.has('barbershop')) forbidden();
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
