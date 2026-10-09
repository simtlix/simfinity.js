import * as simfinity from '@simtlix/simfinity-js';
import { hasAnyRole } from '../auth/permissions.js';
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
// ObjectId.id is a Buffer; use canonical hex for both raw IDs and document references.
const idOf = (value) => (value == null ? null : (value.toHexString?.() ?? String(value._id ?? value.id ?? value)).toLowerCase());
/** Hidden counter written only to serialize concurrent schedule changes. */
const SCHEDULE_LOCK_FIELD = '_bookingScheduleLock';

/** Generates a 6-char alphanumeric confirmation code (excludes ambiguous chars like O, 0, 1, I). */
export function randomConfirmationCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i += 1) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/**
 * Sets `doc.client` to the signed-in user when they cannot book on behalf of someone else.
 * Platform admins and shop owners keep whatever `client` was sent in the mutation.
 */
export function assignActingUserAsClientUnlessCanBookForOthers(doc, context) {
  const userId = context?.user?.id;
  if (userId && !hasAnyRole(context, ['PLATFORM_ADMIN', 'OWNER'])) {
    doc.client = userId;
  }
}

/** Normalizes barbershop id from mutation args or persisted document (object or raw id). */
export function resolveBarbershopIdFromBookingPayload(args, doc) {
  const raw = args.barbershop || doc.barbershop;
  if (raw == null) return raw;
  return typeof raw === 'object'
    ? (raw.id || raw._id || String(raw))
    : raw;
}

/** Ensures the target barbershop exists and is approved; otherwise throws. */
export async function assertBarbershopApprovedForBooking(barbershopId, session) {
  const BarbershopModel = simfinity.getModel(simfinity.getType('barbershop'));
  const query = BarbershopModel.findById(barbershopId);
  if (session) query.session(session);
  const shop = await query.lean();
  if (!shop || shop.state !== 'APPROVED') {
    throw new Error('Barbershop is not available for booking');
  }
}

/** Fills standard fields when omitted (new bookings and legacy payloads). */
export function applyMissingBookingFieldDefaults(doc) {
  if (!doc.confirmationCode) {
    doc.confirmationCode = randomConfirmationCode();
  }
  if (!doc.paymentMethod) {
    doc.paymentMethod = 'ON_SITE';
  }
  if (!doc.state) {
    doc.state = 'CONFIRMED';
  }
  if (!doc.createdAt) {
    doc.createdAt = new Date().toISOString();
  }
}

/**
 * Derives `totalPrice` from embedded lines when present, and always derives `endTime` from the start
 * time and line durations, so an `endTime` sent by the client is never stored.
 */
export function recalculatePriceAndEndTimeFromLines(doc) {
  if (doc.lines?.length) doc.totalPrice = doc.lines.reduce((sum, line) => sum + (line.price || 0), 0);
  doc.endTime = bookingEndTime(doc.startTime, doc.lines);
}

/** Sets a server-derived field in an update and drops any client request to unset it. */
function setDerivedChange(changes, field, value) {
  changes[field] = value;
  if (!changes.$unset || !Object.hasOwn(changes.$unset, field)) return;
  delete changes.$unset[field];
  if (!Object.keys(changes.$unset).length) delete changes.$unset;
}

/**
 * Rejects malformed lines, then replaces each line's duration with its service's or bundle's
 * catalog duration. Lines whose reference does not resolve keep their captured, non-negative
 * duration (MongoDB accepts dangling references).
 */
export async function applyCatalogLineDurations(lines, session) {
  if (!lines?.length) return;
  const invalid = findLineViolation(lines);
  if (invalid) throw new simfinity.SimfinityError(invalid.message, invalid.code, 400);
  const durations = async (name, field, ids) => {
    if (!ids.length) return new Map();
    const rows = await model(name).find({ _id: { $in: ids } }).select(field).session(session).lean();
    return new Map(rows.map((row) => [idOf(row._id), row[field] ?? 0]));
  };
  const services = await durations('service', 'durationMinutes', lines.filter((line) => line.service).map((line) => line.service));
  const bundles = await durations('bundle', 'totalDurationMinutes', lines.filter((line) => !line.service && line.bundle).map((line) => line.bundle));
  for (const line of lines) {
    const duration = line.service ? services.get(idOf(line.service)) : bundles.get(idOf(line.bundle));
    if (duration !== undefined) line.durationMinutes = duration;
  }
}

/** Confirmed bookings of a barbershop on a date, read natively without the client booking scope. */
export async function findSlotHoldingBookings(barbershopId, scheduledDate, session, excludeId) {
  const rows = await model('booking')
    .find({ barbershop: barbershopId, scheduledDate, state: SLOT_HOLDING_STATE })
    .select('startTime endTime professional')
    .session(session)
    .lean();
  return rows
    .filter((row) => excludeId == null || idOf(row._id) !== idOf(excludeId))
    .map((row) => ({ startTime: row.startTime, endTime: row.endTime, professional: idOf(row.professional) }));
}

/** ID of a booking the signed-in user made as its client, or null for anyone else's booking. */
export async function findOwnBookingId(bookingId, session, context) {
  const userId = context?.user?.id;
  const booking = await model('booking').findById(bookingId).select('client').session(session).lean();
  return booking && userId != null && idOf(booking.client) === idOf(userId) ? idOf(booking._id) : null;
}

/**
 * Serializes schedule changes: writing the professional (or, without one, the shop and all of its
 * professionals) in the transaction makes a concurrent transaction fail with a WriteConflict, which
 * Simfinity retries with a fresh snapshot that sees the committed booking.
 */
export async function lockBookingSchedule(barbershopId, professionalId, session) {
  const bump = { $inc: { [SCHEDULE_LOCK_FIELD]: 1 } };
  const options = { session, strict: false };
  try {
    if (professionalId) {
      await model('professional').updateOne({ _id: professionalId }, bump, options);
    } else {
      await model('barbershop').updateOne({ _id: barbershopId }, bump, options);
      await model('professional').updateMany({ barbershop: barbershopId }, bump, options);
    }
  } catch (error) {
    if (!error?.errorLabels?.includes('TransientTransactionError')) throw error;
    // The runtime waits its own short random backoff before retrying; this extra pause spreads
    // concurrent retries further apart.
    await new Promise((resolve) => { setTimeout(resolve, 20 + Math.random() * 80); });
    // Keep the label so the runtime still retries; only its final attempt reaches the client.
    const busy = new simfinity.SimfinityError('Another booking for this schedule is being saved; try again', 'BOOKING_SCHEDULE_BUSY', 409);
    busy.errorLabels = error.errorLabels;
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
  const barbershop = await model('barbershop').findById(barbershopId).session(session).lean();
  if (!barbershop || ((moved || shopChanged) && barbershop.state !== 'APPROVED')) throw new Error('Barbershop is not available for booking');
  let professional = null;
  if (professionalId) {
    professional = await model('professional').findById(professionalId).session(session).lean();
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
  onUpdating: async (id, changes, session) => {
    const { $unset = {}, ...set } = changes;
    const stored = await model('booking').findById(id).session(session).lean();
    const doc = { ...stored, ...set };
    for (const field of Object.keys($unset)) delete doc[field];
    const touched = (field) => Object.hasOwn(set, field) || Object.hasOwn($unset, field);
    if (Object.hasOwn(set, 'startTime')) changes.startTime = doc.startTime = normalizeClock(set.startTime);
    const linesChanged = touched('lines');
    if (linesChanged) await applyCatalogLineDurations(doc.lines, session);
    if (linesChanged && !doc.lines?.length) {
      setDerivedChange(changes, 'totalPrice', 0);
    } else if (linesChanged || set.startTime) {
      recalculatePriceAndEndTimeFromLines(doc);
      setDerivedChange(changes, 'totalPrice', doc.totalPrice);
    }
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
    assignActingUserAsClientUnlessCanBookForOthers(doc, context);
    const barbershopId = resolveBarbershopIdFromBookingPayload(args, doc);
    await assertBarbershopApprovedForBooking(barbershopId, session);
    applyMissingBookingFieldDefaults(doc);
    if (doc.startTime != null) doc.startTime = normalizeClock(doc.startTime);
    await applyCatalogLineDurations(doc.lines, session);
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
