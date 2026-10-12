import pg from 'pg';
import * as simfinity from '@simtlix/simfinity-postgres';
import { hasAnyRole } from '../auth/permissions.js';
import { databaseSchema } from '../database.js';
import { findAll } from './scopeHelpers.js';
import { bundleServiceTotals, loadServicesById } from './bundle.controller.js';
import {
  SLOT_HOLDING_STATE,
  bookingEndTime,
  bookingSlotChange,
  findLineViolation,
  findOverlappingBooking,
  findScheduleViolation,
  linesDurationMinutes,
  normalizeClock,
} from './booking.schedule.js';

const model = (name) => simfinity.getModel(simfinity.getType(name));
// PostgreSQL UUIDs accept either case but are returned in canonical lowercase form.
const idOf = (value) => (value == null ? null : String(value.id ?? value._id ?? value).toLowerCase());
const table = (name) => `${pg.escapeIdentifier(databaseSchema)}.${pg.escapeIdentifier(name)}`;
/** PostgreSQL errors that Simfinity retries: serialization failure and deadlock. */
const RETRYABLE_CODES = ['40001', '40P01'];

/** Generates a 6-char alphanumeric confirmation code (excludes ambiguous chars like O, 0, 1, I). */
export function randomConfirmationCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i += 1) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/**
 * Sets `doc.client` to the signed-in user, who books for themselves by default. The owner of the
 * booking's `shop` keeps the client they name, or no client for a walk-in customer, and a platform
 * admin keeps the client it names. Anyone else, including an owner booking another owner's shop, is
 * the client; protect() rejects them naming someone else.
 */
export function assignActingUserAsClientUnlessCanBookForOthers(doc, context, shop) {
  const userId = context?.user?.id;
  if (!userId) return;
  if (hasAnyRole(context, ['OWNER']) && shop && idOf(shop.owner) === idOf(userId)) return;
  if (hasAnyRole(context, ['PLATFORM_ADMIN']) && doc.client != null) return;
  doc.client = userId;
}

/** Normalizes the barbershop id from mutation args or the document (object or raw id). */
export function resolveBarbershopIdFromBookingPayload(args, doc) {
  const raw = args.barbershop ?? doc.barbershop;
  return raw == null ? raw : idOf(raw);
}

/** Returns the target barbershop when it exists and is approved; otherwise throws. */
export async function assertBarbershopApprovedForBooking(barbershopId, session) {
  const BarbershopModel = simfinity.getModel(simfinity.getType('barbershop'));
  const shop = await BarbershopModel.findById(barbershopId, { session });
  if (!shop || shop.state !== 'APPROVED') {
    throw new Error('Barbershop is not available for booking');
  }
  return shop;
}

/**
 * Sets the fields the API owns on a new booking: a fresh confirmation code and creation time, so
 * values sent in the mutation are never stored, plus the payment method and state when omitted.
 */
export function applyServerOwnedBookingFields(doc, now = new Date()) {
  doc.confirmationCode = randomConfirmationCode();
  doc.createdAt = now.toISOString();
  if (!doc.paymentMethod) {
    doc.paymentMethod = 'ON_SITE';
  }
  if (!doc.state) {
    doc.state = 'CONFIRMED';
  }
}

/** Sum of the line prices; a missing price, or a negative one stored by an earlier version, counts as zero. */
export function linesTotalPrice(lines) {
  return (lines || []).reduce((sum, line) => sum + Math.max(0, Number(line?.price) || 0), 0);
}

/**
 * Always derives `totalPrice` (0 without lines) and `endTime` from the lines and the start time, so a
 * `totalPrice` or `endTime` sent by the client is never stored.
 */
export function recalculatePriceAndEndTimeFromLines(doc) {
  doc.totalPrice = linesTotalPrice(doc.lines);
  doc.endTime = bookingEndTime(doc.startTime, doc.lines);
}

/** Booking fields only the API writes; an update that sends or unsets them leaves them unchanged. */
const SERVER_OWNED_FIELDS = ['confirmationCode', 'createdAt'];

/** Drops changes to server-owned fields, including requests to unset them. */
function dropServerOwnedChanges(changes) {
  for (const field of SERVER_OWNED_FIELDS) {
    delete changes[field];
    if (changes.$unset) delete changes.$unset[field];
  }
  if (changes.$unset && !Object.keys(changes.$unset).length) delete changes.$unset;
}

/**
 * Platform admins and the owner of the booking's barbershop may depart from the catalog on booking
 * lines: send another price or book an inactive service or bundle.
 */
export function canOverrideCatalog(context, barbershop) {
  if (hasAnyRole(context, ['PLATFORM_ADMIN'])) return true;
  const userId = context?.user?.id;
  return Boolean(userId && barbershop && hasAnyRole(context, ['OWNER']) && idOf(barbershop.owner) === idOf(userId));
}

/** Sets a server-derived field in an update and drops any client request to unset it. */
function setDerivedChange(changes, field, value) {
  changes[field] = value;
  if (!changes.$unset || !Object.hasOwn(changes.$unset, field)) return;
  delete changes.$unset[field];
  if (!Object.keys(changes.$unset).length) delete changes.$unset;
}

const lineError = (message) => new simfinity.SimfinityError(message, 'INVALID_BOOKING_LINE', 400);
/** The catalog item a booking line references, as `service:<id>` or `bundle:<id>`. */
const lineReference = (line) => (line?.service ? `service:${idOf(line.service)}` : `bundle:${idOf(line?.bundle)}`);
/** A stored line's price, counting a negative one stored by an earlier version as zero. */
const storedPrice = (line) => (line?.price == null || !Number.isFinite(Number(line.price)) ? undefined : Math.max(0, Number(line.price)));

/**
 * Matches replacement lines to stored ones: each line takes the first unused stored line with the
 * same service or bundle, so a reference the booking already had is recognized even when the lines
 * are reordered or extended.
 */
function storedLineMatcher(storedLines) {
  const byReference = new Map();
  for (const line of storedLines || []) {
    const key = lineReference(line);
    byReference.set(key, [...(byReference.get(key) || []), line]);
  }
  return (line) => byReference.get(lineReference(line))?.shift();
}

/** A service's catalog duration, or a bundle's: the sum of its current services, or its own without them. */
function catalogDuration(line, item, services) {
  if (line.service) return Math.max(0, Number(item.durationMinutes) || 0);
  const totals = bundleServiceTotals(item, services);
  return totals.resolved ? totals.durationMinutes : Math.max(0, Number(item.totalDurationMinutes) || 0);
}

/**
 * Rejects malformed lines, then sets each line's duration and price from its service or bundle, which
 * must belong to the booking's barbershop (INVALID_BOOKING_LINE otherwise):
 * - The duration is the service's, or the sum of the bundle's current services (each listing counts);
 *   a bundle without services keeps its own duration.
 * - A line whose service or bundle a stored line already had (`storedLines`, on updates) keeps that
 *   line's price, so a reschedule keeps the price it was booked at; other lines take the catalog price.
 * - The shop's owner and platform admins (canOverrideCatalog) may send a price from 0 up to the
 *   catalog price (or the line's stored price) and book inactive services and bundles; a reference of
 *   theirs that does not resolve is left to the foreign key, which rejects it. Anyone else cannot add
 *   a line for an inactive service or bundle.
 */
export async function applyCatalogLineValues(lines, barbershop, session, context, storedLines = []) {
  if (!lines?.length) return;
  const invalid = findLineViolation(lines);
  if (invalid) throw new simfinity.SimfinityError(invalid.message, invalid.code, 400);
  const trusted = canOverrideCatalog(context, barbershop);
  const bundleIds = [...new Set(lines.filter((line) => !line.service && line.bundle).map((line) => idOf(line.bundle)))];
  const bundles = new Map(bundleIds.length
    ? (await findAll(model('bundle'), { id: { operator: 'IN', value: bundleIds } }, session)).map((row) => [idOf(row.id), row])
    : []);
  // One query loads the lines' services and the services of their bundles.
  const services = await loadServicesById([
    ...lines.filter((line) => line.service).map((line) => line.service),
    ...[...bundles.values()].flatMap((bundle) => (bundle.services || []).map((item) => item?.service)),
  ], session);
  const barbershopId = idOf(barbershop?.id);
  const takeStoredLine = storedLineMatcher(storedLines);
  for (const line of lines) {
    const stored = takeStoredLine(line);
    const keptPrice = storedPrice(stored);
    const item = line.service ? services.get(idOf(line.service)) : bundles.get(idOf(line.bundle));
    if (!item) {
      if (!trusted) throw lineError('Booking lines must reference an existing service or bundle of the barbershop');
      if (line.price == null && keptPrice !== undefined) line.price = keptPrice;
      continue;
    }
    if (idOf(item.barbershop) !== barbershopId) throw lineError("Booking lines must reference services or bundles of the booking's barbershop");
    // A booking keeps a service or bundle withdrawn after it was booked when its lines are resent.
    if (!trusted && !stored && item.isActive === false) throw lineError('Inactive services and bundles cannot be booked');
    line.durationMinutes = catalogDuration(line, item, services);
    const catalogPrice = Math.max(0, Number(item.price) || 0);
    if (trusted && line.price != null) {
      if (line.price > catalogPrice && line.price !== keptPrice) throw lineError('A booking line price cannot exceed the catalog price');
    } else {
      line.price = keptPrice ?? catalogPrice;
    }
  }
}

/** Confirmed bookings of a barbershop on a date, read natively without the client booking scope. */
export async function findSlotHoldingBookings(barbershopId, scheduledDate, session, excludeId) {
  const rows = await findAll(model('booking'), {
    barbershop: { terms: [{ path: 'id', operator: 'EQ', value: barbershopId }] },
    scheduledDate: { operator: 'EQ', value: scheduledDate },
    state: { operator: 'EQ', value: SLOT_HOLDING_STATE },
  }, session);
  return rows
    .filter((row) => excludeId == null || idOf(row.id) !== idOf(excludeId))
    .map((row) => ({ startTime: row.startTime, endTime: row.endTime, professional: idOf(row.professional) }));
}

/** ID of a booking the signed-in user made as its client, or null for anyone else's booking. */
export async function findOwnBookingId(bookingId, session, context) {
  const userId = context?.user?.id;
  const booking = await model('booking').findById(bookingId, { session });
  return booking && userId != null && idOf(booking.client) === idOf(userId) ? idOf(booking.id) : null;
}

/**
 * Serializes schedule changes: updating the professional row (or, without one, the shop row and all
 * of its professionals) in the transaction makes a concurrent REPEATABLE READ transaction wait and
 * fail with a serialization error, which Simfinity retries with a fresh snapshot.
 */
export async function lockBookingSchedule(barbershopId, professionalId, session) {
  try {
    if (professionalId) {
      await session.query(`UPDATE ${table('professional')} SET id = id WHERE id = $1`, [professionalId]);
    } else {
      await session.query(`UPDATE ${table('barbershop')} SET id = id WHERE id = $1`, [barbershopId]);
      await session.query(`UPDATE ${table('professional')} SET id = id WHERE barbershop = $1`, [barbershopId]);
    }
  } catch (error) {
    if (!RETRYABLE_CODES.includes(error?.code)) throw error;
    // Keep the SQLSTATE so the runtime still retries; only its final attempt reaches the client.
    const busy = new simfinity.SimfinityError('Another booking for this schedule is being saved; try again', 'BOOKING_SCHEDULE_BUSY', 409);
    busy.code = error.code;
    throw busy;
  }
}

/**
 * Rejects a confirmed booking whose slot is missing or malformed, outside the shop's (or
 * professional's) hours or advance window, or overlapping another confirmed booking; see
 * booking.schedule.js. `moved: false` marks a booking that keeps its date and time: it skips the
 * past and advance rules, and a legacy booking without a date or time is not checked. A booking
 * that is new, moved or placed in another shop (`shopChanged`) needs an approved shop.
 */
export async function assertBookingSlotAvailable(booking, session, { excludeId, moved = true, shopChanged = false } = {}) {
  if (booking.state !== SLOT_HOLDING_STATE || (!moved && (!booking.scheduledDate || !booking.startTime))) return;
  const barbershopId = idOf(booking.barbershop);
  const professionalId = idOf(booking.professional);
  const barbershop = await model('barbershop').findById(barbershopId, { session });
  if (!barbershop || ((moved || shopChanged) && barbershop.state !== 'APPROVED')) throw new Error('Barbershop is not available for booking');
  let professional = null;
  if (professionalId) {
    professional = await model('professional').findById(professionalId, { session });
    if (idOf(professional?.barbershop) !== barbershopId) {
      throw new simfinity.SimfinityError('The professional does not work at this barbershop', 'INVALID_BOOKING_PROFESSIONAL', 400);
    }
  }
  const durationMinutes = linesDurationMinutes(booking.lines);
  const { scheduledDate, startTime } = booking;
  const violation = findScheduleViolation({ scheduledDate, startTime, durationMinutes, barbershop, professional, checkAdvanceWindow: moved });
  if (violation) throw new simfinity.SimfinityError(violation.message, violation.code, 400);
  await lockBookingSchedule(barbershopId, professionalId, session);
  const bookings = await findSlotHoldingBookings(barbershopId, scheduledDate, session, excludeId);
  if (findOverlappingBooking({ startTime, durationMinutes, professionalId, bufferMinutes: barbershop.bufferMinutes, bookings })) {
    throw new simfinity.SimfinityError('The selected time is no longer available', 'BOOKING_SLOT_UNAVAILABLE', 409);
  }
}

export const bookingController = {
  onUpdating: async (id, changes, session, context) => {
    dropServerOwnedChanges(changes);
    const { $unset = {}, ...set } = changes;
    const stored = await model('booking').findById(id, { session });
    const doc = { ...stored, ...set };
    for (const field of Object.keys($unset)) delete doc[field];
    const touched = (field) => Object.hasOwn(set, field) || Object.hasOwn($unset, field);
    if (Object.hasOwn(set, 'startTime')) changes.startTime = doc.startTime = normalizeClock(set.startTime);
    const linesChanged = touched('lines');
    if (linesChanged && doc.lines?.length) {
      const barbershop = await model('barbershop').findById(idOf(doc.barbershop), { session });
      await applyCatalogLineValues(doc.lines, barbershop, session, context, stored?.lines);
    }
    // The server owns totalPrice: every update, transitions included, stores the sum of the resulting
    // line prices, which also corrects a total that an earlier version let a client write.
    setDerivedChange(changes, 'totalPrice', linesTotalPrice(doc.lines));
    // The server owns endTime: an update that sends it, or changes the start time or lines, stores
    // the value derived from the resulting start time and lines, which the checks below also use.
    if (linesChanged || touched('startTime') || touched('endTime')) {
      doc.endTime = bookingEndTime(doc.startTime, doc.lines);
      setDerivedChange(changes, 'endTime', doc.endTime);
    }
    // Edit forms resend unchanged fields; only a booking whose held time really changes is
    // rechecked, and only one moved to another date or time must respect the advance window.
    const { moved, changed } = bookingSlotChange(stored, doc, idOf);
    const shopChanged = idOf(stored?.barbershop) !== idOf(doc.barbershop);
    if (changed) await assertBookingSlotAvailable(doc, session, { excludeId: id, moved, shopChanged });
  },
  onSaving: async (doc, args, session, context) => {
    const barbershopId = resolveBarbershopIdFromBookingPayload(args, doc);
    const barbershop = await assertBarbershopApprovedForBooking(barbershopId, session);
    assignActingUserAsClientUnlessCanBookForOthers(doc, context, barbershop);
    applyServerOwnedBookingFields(doc);
    if (doc.startTime != null) doc.startTime = normalizeClock(doc.startTime);
    await applyCatalogLineValues(doc.lines, barbershop, session, context);
    recalculatePriceAndEndTimeFromLines(doc);
    await assertBookingSlotAvailable(doc, session);
  },
  onSaved: async (booking, args) => {
    // A nested create links the booking to its parent shop only after onSaving checked the shop it
    // names, so a booking stored in any other shop was never checked there.
    const checked = resolveBarbershopIdFromBookingPayload(args, {});
    // ObjectId hex and UUID strings are case-insensitive, so compare them in one case.
    if (checked != null && idOf(booking.barbershop) !== idOf(checked)) {
      throw new simfinity.SimfinityError('A nested booking must name the barbershop it is created in', 'INVALID_BOOKING_BARBERSHOP', 400);
    }
  },
};
