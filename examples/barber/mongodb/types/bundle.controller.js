import * as simfinity from '@simtlix/simfinity-js';

/** Throws if `doc.price` is >= the sum of its constituent service prices. */
export async function assertBundlePriceBelowServiceSum(doc, session) {
  if (!doc.services?.length) return;
  const ServiceModel = simfinity.getModel(simfinity.getType('service'));
  const svcIds = doc.services.map((s) => s.service);
  const query = ServiceModel.find({ _id: { $in: svcIds } });
  if (session) query.session(session);
  const svcs = await query.lean();
  const sum = svcs.reduce((a, s) => a + (s.price || 0), 0);
  if (doc.price != null && sum > 0 && doc.price >= sum) {
    throw new Error('Bundle price must be less than the sum of service prices (MVP rule)');
  }
}

/** Derives `doc.totalDurationMinutes` from the durations of its constituent services. */
export async function recalculateBundleDuration(doc, session) {
  if (!doc.services?.length) return;
  const ServiceModel = simfinity.getModel(simfinity.getType('service'));
  const svcIds = doc.services.map((s) => s.service);
  const query = ServiceModel.find({ _id: { $in: svcIds } });
  if (session) query.session(session);
  const svcs = await query.lean();
  doc.totalDurationMinutes = svcs.reduce((s, svc) => s + (svc.durationMinutes || 0), 0);
}

export const bundleController = {
  onUpdating: async (id, changes, session) => {
    const model = simfinity.getModel(simfinity.getType('bundle'));
    const { $unset = {}, ...set } = changes;
    const doc = { ...await model.findById(id).session(session).lean(), ...set };
    for (const field of Object.keys($unset)) delete doc[field];
    await assertBundlePriceBelowServiceSum(doc, session);
    if (Object.hasOwn(set, 'services') || Object.hasOwn($unset, 'services')) {
      await recalculateBundleDuration(doc, session);
      changes.totalDurationMinutes = doc.services?.length ? doc.totalDurationMinutes : 0;
    }
  },
  onSaving: async (doc, _args, session) => {
    await assertBundlePriceBelowServiceSum(doc, session);
    await recalculateBundleDuration(doc, session);
  },
};
