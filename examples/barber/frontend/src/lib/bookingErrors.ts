/*
 * Booking API rejections the booking page explains to the client. Keys live under "booking." in
 * public/i18n/es.json and en.json; the Spanish fallbacks match es.json.
 */

export type BookingMessage = { key: string; fallback: string };

/** Rejections that mean the chosen time can no longer be booked, so the client picks another one. */
export const SLOT_ERROR_CODES = ["BOOKING_SLOT_UNAVAILABLE", "BOOKING_OUTSIDE_HOURS", "BOOKING_OUTSIDE_ADVANCE_WINDOW"];

const SCHEDULE_BUSY: BookingMessage = {
  key: "errors.scheduleBusy",
  fallback: "Se está guardando otra reserva para este horario. Intentá de nuevo.",
};

export const BOOKING_ERRORS: Record<string, BookingMessage> = {
  BOOKING_SLOT_UNAVAILABLE: { key: "errors.slotUnavailable", fallback: "Ese horario ya fue reservado. Elegí otro horario." },
  BOOKING_OUTSIDE_HOURS: {
    key: "errors.outsideHours",
    fallback: "Ese horario está fuera del horario de atención. Elegí otro horario.",
  },
  BOOKING_OUTSIDE_ADVANCE_WINDOW: {
    key: "errors.outsideAdvanceWindow",
    fallback: "Ese horario ya no respeta la anticipación que pide la barbería. Elegí otro horario.",
  },
  BOOKING_SCHEDULE_BUSY: SCHEDULE_BUSY,
  TRANSACTION_RETRY_EXCEEDED: SCHEDULE_BUSY,
};

export const BOOKING_FAILED: BookingMessage = { key: "bookingFailed", fallback: "No se pudo confirmar la reserva." };

export const RESCHEDULE_UNAVAILABLE: BookingMessage = {
  key: "errors.rescheduleUnavailable",
  fallback: "Este turno ya no está confirmado y no se puede reprogramar. Revisá tus turnos.",
};

/** Added to a rejected slot change when the booking is still confirmed. */
export const ORIGINAL_KEPT: BookingMessage = { key: "errors.originalKept", fallback: "Tu turno original no cambió." };

/** Code of the first GraphQL error of a failed request, or "" when there is none. */
export function bookingErrorCode(error: unknown): string {
  const graphQLErrors = (error as { graphQLErrors?: { extensions?: { code?: unknown } }[] } | null)?.graphQLErrors;
  const code = graphQLErrors?.[0]?.extensions?.code;
  return typeof code === "string" ? code : "";
}

export function bookingErrorMessage(code: string, rescheduling = false): BookingMessage {
  if (rescheduling && code === "BAD_REQUEST") return RESCHEDULE_UNAVAILABLE;
  return BOOKING_ERRORS[code] ?? BOOKING_FAILED;
}
