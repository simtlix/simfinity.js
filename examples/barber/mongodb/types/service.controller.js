import { refreshBundleDurationsForService } from './bundle.controller.js';

/**
 * A bundle with services lasts as long as they do, and bookings use their current durations. So when a
 * service's duration changes, through `updateservice` or its shop's `services.updated`, or the service is
 * deleted, the bundles that list it store their new total in the same transaction.
 */
export const serviceController = {
  onUpdating: async (id, changes, session) => {
    const { $unset = {}, ...set } = changes;
    if (!Object.hasOwn(set, 'durationMinutes') && !Object.hasOwn($unset, 'durationMinutes')) return;
    await refreshBundleDurationsForService(id, session, { durationMinutes: set.durationMinutes ?? null });
  },
  onDelete: async (service, session) => {
    if (service) await refreshBundleDurationsForService(service._id ?? service.id, session, { removed: true });
  },
};
