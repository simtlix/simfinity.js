import * as simfinity from '@simtlix/simfinity-js';

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

export const reviewController = {
  onDelete: async (result, session) => {
    if (result?.barbershop) {
      await refreshBarbershopReviewStats(result.barbershop, session, result._id);
    }
  },
  onSaving: async (doc) => {
    applyReviewDefaults(doc);
  },
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
