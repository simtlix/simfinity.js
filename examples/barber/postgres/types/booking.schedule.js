/**
 * Booking schedule rules shared by the booking controller and the availability mutation.
 * They are pure: callers load the barbershop, professional and bookings with native model calls.
 * Dates use 'YYYY-MM-DD' and times 'HH:mm', both in the barbershop timezone.
 */

/** Only confirmed bookings hold time; rescheduling keeps that state. */
export const SLOT_HOLDING_STATE = 'CONFIRMED';

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_DAY = 86_400_000;

/** Minutes after midnight for 'HH:mm' (or 'H:mm'); null when malformed. */
export function parseClock(value) {
  const match = typeof value === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(value.trim()) : null;
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours > 23 || minutes > 59 ? null : hours * 60 + minutes;
}

/** Like parseClock for the end of a range (closing, break or booking end), where '24:00' is minute 1440. */
export function parseEndClock(value) {
  return typeof value === 'string' && value.trim() === '24:00' ? MINUTES_PER_DAY : parseClock(value);
}

/** Zero-padded 'HH:mm' for minutes after midnight; minute 1440 is '24:00'. */
export function formatClock(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Zero-padded 'HH:mm' for a valid clock such as '9:05'; other values are returned unchanged. */
export function normalizeClock(value) {
  const minutes = parseClock(value);
  return minutes == null ? value : formatClock(minutes);
}

/** Days since the Unix epoch for a real 'YYYY-MM-DD' calendar date; null otherwise. */
export function dayNumber(value) {
  const match = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.getTime() / MS_PER_DAY;
}

/** Current wall-clock day number and minute in `timeZone`; a missing or unknown zone uses UTC. */
export function zonedNow(timeZone, now = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    }).formatToParts(now);
  } catch {
    return zonedNow('UTC', now);
  }
  const part = (type) => Number(parts.find((item) => item.type === type).value);
  return {
    day: Date.UTC(part('year'), part('month') - 1, part('day')) / MS_PER_DAY,
    minutes: part('hour') * 60 + part('minute'),
  };
}

/**
 * Hours that apply on a weekday, in minutes: the shop's row narrowed by the professional's own row.
 * The day is closed when either row closes it; it opens at the later opening, closes at the earlier
 * closing and keeps both rows' breaks. A row limits open and close only when it sets both times.
 * Returns `{ isClosed, open, close, breaks }`, or null when neither has a row (no hour limits).
 */
export function hoursForDay(barbershop, professional, weekday) {
  const find = (rows) => (Array.isArray(rows) ? rows.find((row) => row?.dayOfWeek === weekday) : undefined);
  const rows = [find(barbershop?.businessHours), find(professional?.businessHours)].filter(Boolean);
  if (!rows.length) return null;
  const spans = (startField, endField) => rows
    .map((row) => [parseClock(row[startField]), parseEndClock(row[endField])])
    .filter(([start, end]) => start != null && end != null);
  const windows = spans('openTime', 'closeTime');
  return {
    isClosed: rows.some((row) => Boolean(row.isClosed)),
    open: windows.length ? Math.max(...windows.map(([open]) => open)) : null,
    close: windows.length ? Math.min(...windows.map(([, close]) => close)) : null,
    breaks: spans('breakStartTime', 'breakEndTime').filter(([start, end]) => start < end),
  };
}

/** Total minutes of the booking lines; a negative stored duration counts as zero. */
export function linesDurationMinutes(lines) {
  return (lines || []).reduce((sum, line) => sum + Math.max(0, Number(line?.durationMinutes) || 0), 0);
}

/**
 * The stored end of a booking: its start plus its line durations, as 'HH:mm' ('24:00' at midnight),
 * or null without a valid start. The server always derives it and never stores a client value.
 */
export function bookingEndTime(startTime, lines) {
  const start = parseClock(startTime);
  return start == null ? null : formatClock(start + linesDurationMinutes(lines));
}

/** Half-open ranges [a0, a1) and [b0, b1) intersect; an empty range still collides at a shared start. */
export function rangesOverlap(a0, a1, b0, b1) {
  return (a0 < b1 && b0 < a1) || a0 === b0;
}

/** A booking without a professional holds the whole shop, and a booking without one needs the whole shop. */
export function blocksProfessional(existingProfessionalId, professionalId) {
  return !professionalId || !existingProfessionalId || String(existingProfessionalId).toLowerCase() === String(professionalId).toLowerCase();
}

const violation = (code, message) => ({ code, message });

/**
 * First malformed booking line, as `{ code, message }`, or null. Each line references exactly one
 * service or bundle, and a captured duration must be a whole, non-negative number of minutes.
 */
export function findLineViolation(lines) {
  for (const line of lines || []) {
    if (!line?.service === !line?.bundle) {
      return violation('INVALID_BOOKING_LINE', 'Each booking line must reference either a service or a bundle');
    }
    const duration = line.durationMinutes;
    if (duration != null && !(Number.isInteger(duration) && duration >= 0)) {
      return violation('INVALID_BOOKING_LINE', 'Booking line durations must be whole, non-negative minutes');
    }
  }
  return null;
}

/**
 * First schedule rule broken by a booking, as `{ code, message }`, or null.
 * The booking holds [start, start + durationMinutes + bufferMinutes), which must fit the day's
 * hours (see hoursForDay) and avoid their breaks. It must start at least minAdvanceHours from now and
 * fall within maxAdvanceDays, unless `checkAdvanceWindow` is false (a booking that keeps its date
 * and time). A weekday without a businessHours row is not restricted by hours.
 */
export function findScheduleViolation({
  scheduledDate, startTime, durationMinutes, barbershop, professional, now = new Date(), checkAdvanceWindow = true,
}) {
  const day = dayNumber(scheduledDate);
  const start = parseClock(startTime);
  if (day == null || start == null) {
    return violation('INVALID_BOOKING_TIME', "Bookings need a scheduledDate in 'YYYY-MM-DD' and a startTime in 'HH:mm'");
  }
  const end = start + durationMinutes;
  const held = end + Math.max(0, Number(barbershop?.bufferMinutes) || 0);
  if (end > MINUTES_PER_DAY) return violation('BOOKING_OUTSIDE_HOURS', 'The booking must end on its scheduled date');
  const hours = hoursForDay(barbershop, professional, new Date(day * MS_PER_DAY).getUTCDay());
  if (hours && (hours.isClosed || (hours.open != null && hours.open >= hours.close))) {
    return violation('BOOKING_OUTSIDE_HOURS', `Bookings are closed on ${scheduledDate}`);
  }
  if (hours?.open != null && (start < hours.open || held > hours.close)) {
    return violation('BOOKING_OUTSIDE_HOURS', `The booking must fit within ${formatClock(hours.open)}-${formatClock(hours.close)} on ${scheduledDate}`);
  }
  const blocked = hours?.breaks.find(([breakStart, breakEnd]) => rangesOverlap(start, held, breakStart, breakEnd));
  if (blocked) {
    return violation('BOOKING_OUTSIDE_HOURS', `The booking overlaps the ${formatClock(blocked[0])}-${formatClock(blocked[1])} break`);
  }
  if (!checkAdvanceWindow) return null;
  const current = zonedNow(barbershop?.timezone, now);
  const minAdvanceHours = Math.max(0, Number(barbershop?.minAdvanceHours) || 0);
  if (day * MINUTES_PER_DAY + start < current.day * MINUTES_PER_DAY + current.minutes + minAdvanceHours * 60) {
    return violation('BOOKING_OUTSIDE_ADVANCE_WINDOW', minAdvanceHours
      ? `Bookings must start at least ${minAdvanceHours} hours from now`
      : 'The booking time has already passed');
  }
  const maxAdvanceDays = barbershop?.maxAdvanceDays;
  if (maxAdvanceDays != null && day - current.day > maxAdvanceDays) {
    return violation('BOOKING_OUTSIDE_ADVANCE_WINDOW', `Bookings can be made at most ${maxAdvanceDays} days ahead`);
  }
  return null;
}

/**
 * First holding booking that collides with the new one. Bookings are `{ startTime, endTime, professional }`
 * with the professional as an ID string; both ranges are widened by bufferMinutes.
 */
export function findOverlappingBooking({ startTime, durationMinutes, professionalId, bufferMinutes, bookings }) {
  const buffer = Math.max(0, Number(bufferMinutes) || 0);
  const start = parseClock(startTime);
  const end = start + durationMinutes + buffer;
  return bookings.find((booking) => {
    const bookingStart = parseClock(booking.startTime);
    if (bookingStart == null || !blocksProfessional(booking.professional, professionalId)) return false;
    const bookingEnd = Math.max(bookingStart, parseEndClock(booking.endTime) ?? bookingStart);
    return rangesOverlap(start, end, bookingStart, bookingEnd + buffer);
  }) ?? null;
}

/**
 * What an update really changes in the time a booking holds, comparing values rather than which
 * fields the payload carries. `moved`: it now starts on another date or time, or starts holding
 * time. `changed`: moved, or its barbershop, professional or lines (references and durations)
 * differ. `idOf` normalizes the backend's reference values to ID strings.
 */
export function bookingSlotChange(stored, next, idOf) {
  const key = (booking) => ({
    holds: booking?.state === SLOT_HOLDING_STATE,
    time: [booking?.scheduledDate ?? null, parseClock(booking?.startTime) ?? booking?.startTime ?? null],
    place: [idOf(booking?.barbershop), idOf(booking?.professional)],
    lines: (booking?.lines || []).map((line) => [idOf(line?.service), idOf(line?.bundle), Number(line?.durationMinutes) || 0]),
  });
  const before = key(stored);
  const after = key(next);
  const same = (field) => JSON.stringify(before[field]) === JSON.stringify(after[field]);
  const moved = !before.holds || !same('time');
  return { moved, changed: moved || !same('place') || !same('lines') };
}
