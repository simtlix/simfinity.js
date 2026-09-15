import * as simfinity from '@simtlix/simfinity-postgres';
import { hasAnyRole } from '../auth/permissions.js';

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
  const shop = await BarbershopModel.findById(barbershopId, { session });
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

/** Derives `totalPrice` and `endTime` from embedded lines when present. */
export function recalculatePriceAndEndTimeFromLines(doc) {
  if (!doc.lines?.length) return;
  doc.totalPrice = doc.lines.reduce((sum, line) => sum + (line.price || 0), 0);
  if (!doc.startTime) return;
  const totalMins = doc.lines.reduce((sum, line) => sum + (line.durationMinutes || 0), 0);
  const [h, m] = doc.startTime.split(':').map(Number);
  const endMins = h * 60 + m + totalMins;
  doc.endTime = `${String(Math.floor(endMins / 60)).padStart(2, '0')}:${String(endMins % 60).padStart(2, '0')}`;
}

export const bookingController = {
  onUpdating: async (id, changes, session) => {
    const model = simfinity.getModel(simfinity.getType('booking'));
    const { $unset = {}, ...set } = changes;
    const doc = { ...await model.findById(id, { session }), ...set };
    for (const field of Object.keys($unset)) delete doc[field];
    const linesChanged = Object.hasOwn(set, 'lines') || Object.hasOwn($unset, 'lines');
    if (linesChanged && !doc.lines?.length) {
      changes.totalPrice = 0;
      changes.endTime = doc.startTime ?? null;
    } else if (linesChanged || set.startTime) {
      recalculatePriceAndEndTimeFromLines(doc);
      changes.totalPrice = doc.totalPrice;
      changes.endTime = doc.endTime;
    }
  },
  onSaving: async (doc, args, session, context) => {
    assignActingUserAsClientUnlessCanBookForOthers(doc, context);
    const barbershopId = resolveBarbershopIdFromBookingPayload(args, doc);
    await assertBarbershopApprovedForBooking(barbershopId, session);
    applyMissingBookingFieldDefaults(doc);
    recalculatePriceAndEndTimeFromLines(doc);
  },
};
