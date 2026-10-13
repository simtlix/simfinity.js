import * as simfinity from '@simtlix/simfinity-js';
import { isPlatformAdmin } from './scopeHelpers.js';

const model = (name) => simfinity.getModel(simfinity.getType(name));
// ObjectId.id is a Buffer; compare canonical lowercase hex for raw IDs and references.
const idOf = (value) => (value == null ? null : (value.toHexString?.() ?? String(value._id ?? value.id ?? value)).toLowerCase());

/** Recomputes `averageRating` and `reviewCount` on the parent barbershop after a review is saved/updated. */
export async function refreshBarbershopReviewStats(barbershopId, session, excludedId) {
  const ReviewModel = simfinity.getModel(simfinity.getType('review'));
  const BarbershopModel = simfinity.getModel(simfinity.getType('barbershop'));
  const query = ReviewModel.aggregate([
    { $match: { barbershop: barbershopId, ...(excludedId ? { _id: { $ne: excludedId } } : {}) } },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  if (session) query.session(session);
  const agg = await query;
  const avg = agg[0]?.avg ?? null;
  const count = agg[0]?.count ?? 0;
  await BarbershopModel.updateOne(
    { _id: barbershopId },
    { $set: { averageRating: avg != null ? Math.round(avg * 10) / 10 : null, reviewCount: count } },
    ...(session ? [{ session }] : []),
  );
}

/** Sets `doc.createdAt` to the current ISO timestamp when not already set. */
export function applyReviewDefaults(doc) {
  if (!doc.createdAt) {
    doc.createdAt = new Date().toISOString();
  }
}

/**
 * Checks that the signed-in user may post this review. A platform admin may import any review, with or
 * without a booking. Anyone else reviews an APPROVED barbershop they do not own, through a COMPLETED
 * booking they made there. Each booking takes one review.
 *
 * Concurrent reviews of one booking need no lock: onSaved rewrites the shop's statistics in the same
 * transaction, and a non-admin's review is always at its booking's shop, so two such reviews write the
 * same barbershop record. The later one fails with a write conflict, and Simfinity retries it with a
 * fresh snapshot, which sees the committed review and stops here with REVIEW_ALREADY_EXISTS.
 */
export async function assertReviewAllowed(doc, session, context) {
  const bookingId = idOf(doc.booking);
  if (!isPlatformAdmin(context)) {
    const userId = idOf(context?.user?.id);
    const shopId = idOf(doc.barbershop);
    const shop = shopId && await model('barbershop').findById(shopId).select('owner state').session(session).lean();
    if (!shop || shop.state !== 'APPROVED') throw new simfinity.SimfinityError('Barbershop is not available for reviews', 'INVALID_REVIEW_BARBERSHOP', 400);
    if (idOf(shop.owner) === userId) throw new simfinity.auth.ForbiddenError('You cannot review your own barbershop');
    if (!bookingId) throw new simfinity.SimfinityError('A review needs a completed booking', 'REVIEW_BOOKING_REQUIRED', 400);
    const booking = await model('booking').findById(bookingId).select('client barbershop state').session(session).lean();
    // One code for every mismatch, so the answer does not reveal another client's booking.
    if (!booking || idOf(booking.client) !== userId || idOf(booking.barbershop) !== shopId || booking.state !== 'COMPLETED') {
      throw new simfinity.SimfinityError('Only a completed booking you made at this barbershop can be reviewed', 'INVALID_REVIEW_BOOKING', 400);
    }
  }
  if (bookingId && await model('review').exists({ booking: bookingId }).session(session)) {
    throw new simfinity.SimfinityError('This booking already has a review', 'REVIEW_ALREADY_EXISTS', 409);
  }
}

export const reviewController = {
  onDelete: async (result, session) => {
    if (result?.barbershop) {
      await refreshBarbershopReviewStats(result.barbershop, session, result._id);
    }
  },
  onSaving: async (doc, _args, session, context) => {
    await assertReviewAllowed(doc, session, context);
    applyReviewDefaults(doc);
  },
  // This write to the shop record also serializes concurrent reviews of one booking (see assertReviewAllowed).
  onSaved: async (result, _args, session) => {
    if (result?.barbershop) {
      await refreshBarbershopReviewStats(result.barbershop, session);
    }
  },
  onUpdated: async (result, session) => {
    if (result?.barbershop) {
      await refreshBarbershopReviewStats(result.barbershop, session);
    }
  },
};
