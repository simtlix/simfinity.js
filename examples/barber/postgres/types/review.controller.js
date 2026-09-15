import * as simfinity from '@simtlix/simfinity-postgres';
import { findAll } from './scopeHelpers.js';

/** Recomputes `averageRating` and `reviewCount` on the parent barbershop after a review is saved/updated. */
export async function refreshBarbershopReviewStats(barbershopId, session, excludedId) {
  const ReviewModel = simfinity.getModel(simfinity.getType('review'));
  const BarbershopModel = simfinity.getModel(simfinity.getType('barbershop'));
  const rows = await findAll(ReviewModel, {
    barbershop: { terms: [{ path: 'id', operator: 'EQ', value: barbershopId }] },
  }, session);
  const ratings = rows.filter((row) => row.id !== excludedId).map((row) => row.rating);
  const averageRating = ratings.length ? Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length * 10) / 10 : null;
  await BarbershopModel.update(barbershopId, { averageRating, reviewCount: ratings.length }, { session });
}

/** Sets `doc.createdAt` to the current ISO timestamp when not already set. */
export function applyReviewDefaults(doc) {
  if (!doc.createdAt) {
    doc.createdAt = new Date().toISOString();
  }
}

export const reviewController = {
  onDelete: async (result, session) => {
    if (result?.barbershop) await refreshBarbershopReviewStats(result.barbershop, session, result.id);
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
