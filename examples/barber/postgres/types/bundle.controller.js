import * as simfinity from '@simtlix/simfinity-postgres';
import { findAll } from './scopeHelpers.js';

const model = (name) => simfinity.getModel(simfinity.getType(name));
// PostgreSQL UUIDs accept either case but are returned in canonical lowercase form.
const idOf = (value) => (value == null ? null : String(value.id ?? value._id ?? value).toLowerCase());
const invalidService = (message) => new simfinity.SimfinityError(message, 'INVALID_BUNDLE_SERVICE', 400);

/** Services by canonical ID, each loaded once in the session. */
export async function loadServicesById(ids, session) {
  const unique = [...new Set(ids.filter(Boolean).map(idOf))];
  if (!unique.length) return new Map();
  const rows = await findAll(model('service'), { id: { operator: 'IN', value: unique } }, session);
  return new Map(rows.map((row) => [idOf(row), row]));
}

/**
 * Price and duration of a bundle's listed services, from services given by ID: a service listed
 * twice counts twice, an item whose service is not given counts nothing, and negative catalog values
 * count as zero. `count` is the number of listed items and `resolved` the number that were found.
 */
export function bundleServiceTotals(bundle, servicesById) {
  const items = bundle.services || [];
  let price = 0;
  let durationMinutes = 0;
  let resolved = 0;
  for (const item of items) {
    const service = servicesById.get(idOf(item?.service));
    if (!service) continue;
    resolved += 1;
    price += Math.max(0, Number(service.price) || 0);
    durationMinutes += Math.max(0, Number(service.durationMinutes) || 0);
  }
  return { price, durationMinutes, count: items.length, resolved };
}

/**
 * Totals of the bundle's listed services (see bundleServiceTotals). With `strict`, every item must
 * reference an existing service of the bundle's barbershop (INVALID_BUNDLE_SERVICE); without it (an
 * edit that keeps the services), unresolved items count nothing.
 */
export async function sumBundleServices(doc, session, { strict = false } = {}) {
  const servicesById = await loadServicesById((doc.services || []).map((item) => item?.service), session);
  if (strict) {
    const barbershopId = idOf(doc.barbershop);
    for (const item of doc.services || []) {
      const service = servicesById.get(idOf(item?.service));
      if (!service) throw invalidService('Each bundle item must reference an existing service');
      if (idOf(service.barbershop) !== barbershopId) throw invalidService("Bundle services must belong to the bundle's barbershop");
    }
  }
  return bundleServiceTotals(doc, servicesById);
}

/** Throws if `doc.price` is >= the sum of its listed service prices (each listing counts). */
export async function assertBundlePriceBelowServiceSum(doc, session, totals) {
  if (!doc.services?.length) return;
  const { price: sum } = totals ?? await sumBundleServices(doc, session);
  if (doc.price != null && sum > 0 && doc.price >= sum) {
    throw new Error('Bundle price must be less than the sum of service prices (MVP rule)');
  }
}

/** Derives `doc.totalDurationMinutes` from its listed services; a bundle without services keeps its own. */
export async function recalculateBundleDuration(doc, session, totals) {
  if (!doc.services?.length) return;
  doc.totalDurationMinutes = (totals ?? await sumBundleServices(doc, session)).durationMinutes;
}

/**
 * Keeps the stored `totalDurationMinutes` of every bundle that lists a service equal to what a booking
 * of the bundle holds (catalogDuration in booking.controller.js): the sum of its services that resolve,
 * or the stored value when none does. Runs in the service write's session, before the write: pass the
 * service's new `durationMinutes` (null when cleared), or `removed` when the service is being deleted
 * (the foreign key from the bundle's items then refuses the delete and rolls this back).
 */
export async function refreshBundleDurationsForService(serviceId, session, { durationMinutes, removed = false } = {}) {
  const key = idOf(serviceId);
  const bundles = await findAll(model('bundle'), { services: { terms: [{ path: 'service.id', operator: 'EQ', value: key }] } }, session);
  if (!bundles.length) return;
  const servicesById = await loadServicesById(bundles.flatMap((bundle) => (bundle.services || []).map((item) => item?.service)), session);
  if (removed) servicesById.delete(key);
  else if (servicesById.has(key)) servicesById.set(key, { ...servicesById.get(key), durationMinutes });
  for (const bundle of bundles) {
    const totals = bundleServiceTotals(bundle, servicesById);
    if (!totals.resolved || totals.durationMinutes === bundle.totalDurationMinutes) continue;
    await model('bundle').update(bundle.id, { totalDurationMinutes: totals.durationMinutes }, { session });
  }
}

/** Sets a server-derived field in an update and drops any client request to unset it. */
function setDerivedChange(changes, field, value) {
  changes[field] = value;
  if (!changes.$unset || !Object.hasOwn(changes.$unset, field)) return;
  delete changes.$unset[field];
  if (!Object.keys(changes.$unset).length) delete changes.$unset;
}

export const bundleController = {
  onUpdating: async (id, changes, session) => {
    const { $unset = {}, ...set } = changes;
    const stored = await model('bundle').findById(id, { session });
    const doc = { ...stored, ...set };
    for (const field of Object.keys($unset)) delete doc[field];
    const touched = (field) => Object.hasOwn(set, field) || Object.hasOwn($unset, field);
    const servicesChanged = touched('services');
    // New services, and services kept while the bundle moves to another shop, must belong to its
    // shop. Other edits keep working for bundles saved before this rule.
    const strict = servicesChanged || idOf(stored?.barbershop) !== idOf(doc.barbershop);
    const totals = await sumBundleServices(doc, session, { strict });
    await assertBundlePriceBelowServiceSum(doc, session, totals);
    if (totals.count && (servicesChanged || touched('totalDurationMinutes'))) {
      // A bundle with services always lasts as long as they do; a sent duration is ignored.
      setDerivedChange(changes, 'totalDurationMinutes', totals.durationMinutes);
    } else if (totals.resolved && totals.durationMinutes !== stored?.totalDurationMinutes) {
      // Any other save stores the services' current length, so a total that an earlier version left
      // behind a service edit heals (the dashboard's edit page does not send a duration for it).
      changes.totalDurationMinutes = totals.durationMinutes;
    } else if (servicesChanged && !Object.hasOwn(set, 'totalDurationMinutes')) {
      changes.totalDurationMinutes = 0;
    }
  },
  onSaving: async (doc, _args, session) => {
    // A nested bundle is linked to its parent shop before this hook runs, so the check covers it too.
    const totals = await sumBundleServices(doc, session, { strict: true });
    await assertBundlePriceBelowServiceSum(doc, session, totals);
    await recalculateBundleDuration(doc, session, totals);
  },
};
