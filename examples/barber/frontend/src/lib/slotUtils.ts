/*
 * Booking-page slot rules. They mirror the backends' booking.schedule.js checks so the page
 * offers only times the API accepts: a booking holds [start, start + duration + bufferMinutes),
 * which must fit the day's hours, avoid its break and other bookings, start at least
 * minAdvanceHours from now and fall within maxAdvanceDays. Dates are 'YYYY-MM-DD' and times
 * 'HH:mm' in the barbershop timezone.
 */

export type BusinessHour = {
  dayOfWeek?: number | null;
  openTime?: string | null;
  closeTime?: string | null;
  isClosed?: boolean | null;
  breakStartTime?: string | null;
  breakEndTime?: string | null;
};

/** Time held by a confirmed booking, as returned by the `bookingAvailability` mutation. */
export type BusyRange = {
  startTime?: string | null;
  endTime?: string | null;
  professionalId?: string | null;
};

export type ShopNow = { date: string; minutes: number };

export type SlotRequest = {
  date: string;
  /** Total duration of the selected services or bundle. */
  durationMinutes: number;
  /** Selected professional; null or undefined means no preference (the whole shop). */
  professionalId?: string | null;
  busy: BusyRange[];
  businessHours?: BusinessHour[] | null;
  /** The selected professional's own hours; a row for the weekday narrows the shop's. */
  professionalHours?: BusinessHour[] | null;
  slotDurationMinutes?: number | null;
  bufferMinutes?: number | null;
  minAdvanceHours?: number | null;
  maxAdvanceDays?: number | null;
  now: ShopNow;
};

export type Slot = { time: string; available: boolean };

const MINUTES_PER_DAY = 24 * 60;

export function parseClock(value?: string | null): number | null {
  const match = typeof value === "string" ? value.trim().match(/^(\d{1,2}):(\d{2})$/) : null;
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours > 23 || minutes > 59 ? null : hours * 60 + minutes;
}

/** Like parseClock for the end of a range (closing, break or booking end), where '24:00' is minute 1440. */
export function parseEndClock(value?: string | null): number | null {
  return typeof value === "string" && value.trim() === "24:00" ? MINUTES_PER_DAY : parseClock(value);
}

const toClock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** Days since the Unix epoch for a real 'YYYY-MM-DD' date; null otherwise. */
export function dayNumber(value: string): number | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.getTime() / 86_400_000;
}

/** Current wall-clock date and minute in the shop timezone; a missing or unknown zone uses UTC, like the API. */
export function shopNow(timeZone?: string | null, now: Date = new Date()): ShopNow {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "UTC", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(now);
  } catch {
    return shopNow("UTC", now);
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "00";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    minutes: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

/** Half-open ranges intersect; an empty range still collides at a shared start. */
const overlaps = (a0: number, a1: number, b0: number, b1: number) => (a0 < b1 && b0 < a1) || a0 === b0;

/** Bookings without a professional hold the whole shop; no preference needs the whole shop. */
const blocks = (busyProfessionalId?: string | null, professionalId?: string | null) =>
  !professionalId || !busyProfessionalId || busyProfessionalId === professionalId;

export type DayHours = { open: number; close: number; breaks: [number, number][] };

/**
 * Bookable hours for a weekday, in minutes: the shop's row narrowed by the professional's own row,
 * as the API checks them. The day is closed when either row closes it; it opens at the later
 * opening, closes at the earlier closing and keeps both rows' breaks. A row limits opening hours
 * only when both times parse. Null when the day is closed or neither has a row; when rows exist
 * but none supplies a complete window, the page offers 09:00-18:00.
 */
export function hoursForDay(
  businessHours: (BusinessHour | null)[] | null | undefined,
  professionalHours: (BusinessHour | null)[] | null | undefined,
  weekday: number,
): DayHours | null {
  const find = (rows?: (BusinessHour | null)[] | null) => rows?.find((row) => row?.dayOfWeek === weekday) ?? null;
  const rows = [find(businessHours), find(professionalHours)].filter((row): row is BusinessHour => row != null);
  if (!rows.length || rows.some((row) => row.isClosed)) return null;
  const windows = rows
    .map((row): [number | null, number | null] => [parseClock(row.openTime), parseEndClock(row.closeTime)])
    .filter((range): range is [number, number] => range[0] != null && range[1] != null);
  const open = windows.length ? Math.max(...windows.map(([start]) => start)) : 9 * 60;
  const close = windows.length ? Math.min(...windows.map(([, end]) => end)) : 18 * 60;
  if (close <= open) return null;
  const breaks = rows
    .map((row): [number | null, number | null] => [parseClock(row.breakStartTime), parseEndClock(row.breakEndTime)])
    .filter((range): range is [number, number] => range[0] != null && range[1] != null && range[0] < range[1]);
  return { open, close, breaks };
}

export function computeAvailableSlots(request: SlotRequest): Slot[] {
  const day = dayNumber(request.date);
  const today = dayNumber(request.now.date);
  if (day == null || today == null || day < today) return [];
  if (request.maxAdvanceDays != null && day - today > request.maxAdvanceDays) return [];

  const weekday = new Date(day * 86_400_000).getUTCDay();
  const hours = hoursForDay(request.businessHours, request.professionalHours, weekday);
  if (!hours) return [];
  const { open, close, breaks } = hours;

  const buffer = Math.max(0, request.bufferMinutes ?? 0);
  const held = Math.max(0, request.durationMinutes) + buffer;
  const step = request.slotDurationMinutes && request.slotDurationMinutes > 0 ? request.slotDurationMinutes : 30;
  const earliest = (today - day) * MINUTES_PER_DAY + request.now.minutes + Math.max(0, request.minAdvanceHours ?? 0) * 60;
  const busy = request.busy
    .filter((range) => blocks(range.professionalId, request.professionalId))
    .map((range) => ({ start: parseClock(range.startTime), end: parseEndClock(range.endTime) }))
    .filter((range): range is { start: number; end: number | null } => range.start != null)
    .map(({ start, end }) => ({ start, end: Math.max(start, end ?? start) + buffer }));

  const slots: Slot[] = [];
  for (let start = open; start + held <= close && start < close; start += step) {
    const end = start + held;
    const available = start >= earliest
      && !breaks.some(([breakStart, breakEnd]) => overlaps(start, end, breakStart, breakEnd))
      && !busy.some((range) => overlaps(start, end, range.start, range.end));
    slots.push({ time: toClock(start), available });
  }
  return slots;
}
