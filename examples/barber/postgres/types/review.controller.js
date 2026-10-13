import pg from 'pg';
import * as simfinity from '@simtlix/simfinity-postgres';
import { databaseSchema } from '../database.js';
import { isPlatformAdmin } from './scopeHelpers.js';

const model = (name) => simfinity.getModel(simfinity.getType(name));
// PostgreSQL UUIDs accept either case but are returned in canonical lowercase form.
const idOf = (value) => (value == null ? null : String(value.id ?? value._id ?? value).toLowerCase());
const reviewTable = () => `${pg.escapeIdentifier(databaseSchema)}.${pg.escapeIdentifier('review')}`;

/**
 * Recomputes `averageRating` and `reviewCount` on the parent barbershop after a review is saved,
 * updated or deleted. One count/sum query over the indexed `review.barbershop` column runs on the
 * hook's transaction, so it sees the review change and rolls back with it. `excludedId` leaves out
 * the review that `onDelete` is about to delete.
 */
export async function refreshBarbershopReviewStats(barbershopId, session, excludedId) {
  const BarbershopModel = simfinity.getModel(simfinity.getType('barbershop'));
  const { rows: [stats] } = await session.query(
    `SELECT count(*)::int AS count, sum(rating)::float8 AS sum FROM ${reviewTable()}
     WHERE barbershop = $1::uuid AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [idOf(barbershopId), idOf(excludedId)],
  );
  // Same arithmetic as before: sum / count in JavaScript, rounded to one decimal.
  const averageRating = stats.count ? Math.round(stats.sum / stats.count * 10) / 10 : null;
  await BarbershopModel.update(barbershopId, { averageRating, reviewCount: stats.count }, { session });
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
 * REPEATABLE READ transaction, and a non-admin's review is always at its booking's shop, so two such
 * reviews update the same barbershop row. The later one fails with a serialization error, and Simfinity
 * retries it with a fresh snapshot, which sees the committed review and stops here with
 * REVIEW_ALREADY_EXISTS.
 */
export async function assertReviewAllowed(doc, session, context) {
  const bookingId = idOf(doc.booking);
  if (!isPlatformAdmin(context)) {
    const userId = idOf(context?.user?.id);
    const shopId = idOf(doc.barbershop);
    const shop = shopId && await model('barbershop').findById(shopId, { session });
    if (!shop || shop.state !== 'APPROVED') throw new simfinity.SimfinityError('Barbershop is not available for reviews', 'INVALID_REVIEW_BARBERSHOP', 400);
    if (idOf(shop.owner) === userId) throw new simfinity.auth.ForbiddenError('You cannot review your own barbershop');
    if (!bookingId) throw new simfinity.SimfinityError('A review needs a completed booking', 'REVIEW_BOOKING_REQUIRED', 400);
    const booking = await model('booking').findById(bookingId, { session });
    // One code for every mismatch, so the answer does not reveal another client's booking.
    if (!booking || idOf(booking.client) !== userId || idOf(booking.barbershop) !== shopId || booking.state !== 'COMPLETED') {
      throw new simfinity.SimfinityError('Only a completed booking you made at this barbershop can be reviewed', 'INVALID_REVIEW_BOOKING', 400);
    }
  }
  if (!bookingId) return;
  const { rows: [{ reviewed }] } = await session.query(
    `SELECT EXISTS (SELECT 1 FROM ${reviewTable()} WHERE booking = $1::uuid) AS reviewed`,
    [bookingId],
  );
  if (reviewed) throw new simfinity.SimfinityError('This booking already has a review', 'REVIEW_ALREADY_EXISTS', 409);
}

export const reviewController = {
  onDelete: async (result, session) => {
    if (result?.barbershop) await refreshBarbershopReviewStats(result.barbershop, session, result.id);
  },
  onSaving: async (doc, _args, session, context) => {
    await assertReviewAllowed(doc, session, context);
    applyReviewDefaults(doc);
  },
  // This write to the shop row also serializes concurrent reviews of one booking (see assertReviewAllowed).
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
