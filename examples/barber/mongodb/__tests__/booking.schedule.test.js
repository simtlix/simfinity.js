import { describe, it, expect } from 'vitest';
import {
  parseClock,
  parseEndClock,
  formatClock,
  bookingEndTime,
  dayNumber,
  zonedNow,
  hoursForDay,
  linesDurationMinutes,
  rangesOverlap,
  blocksProfessional,
  findScheduleViolation,
  findOverlappingBooking,
  findLineViolation,
  normalizeClock,
  bookingSlotChange,
} from '../types/booking.schedule.js';

// 2026-10-01 is a Thursday; 12:00 UTC is 09:00 in Buenos Aires (UTC-3).
const now = new Date('2026-10-01T12:00:00Z');
const weekday = (dayOfWeek) => ({
  dayOfWeek, openTime: '09:00', closeTime: '18:00', isClosed: dayOfWeek === 0, breakStartTime: '13:00', breakEndTime: '14:00',
});
const shop = {
  timezone: 'America/Argentina/Buenos_Aires',
  bufferMinutes: 10,
  minAdvanceHours: 2,
  maxAdvanceDays: 30,
  businessHours: [0, 1, 2, 3, 4, 5, 6].map(weekday),
};
const check = (scheduledDate, startTime, durationMinutes = 30, overrides = {}) => findScheduleViolation({
  scheduledDate, startTime, durationMinutes, barbershop: shop, professional: null, now, ...overrides,
})?.code ?? null;

describe('clock and calendar parsing', () => {
  it('parses valid clocks and rejects malformed ones', () => {
    expect(parseClock('09:30')).toBe(570);
    expect(parseClock('9:05')).toBe(545);
    for (const value of ['24:00', '10:60', '10:00:00', '', null, undefined, 600]) expect(parseClock(value)).toBeNull();
  });

  it('accepts 24:00 as minute 1440 only at the end of a range', () => {
    expect(parseEndClock('24:00')).toBe(1440);
    expect(parseEndClock('18:30')).toBe(1110);
    for (const value of ['24:01', '25:00', '', null]) expect(parseEndClock(value)).toBeNull();
    expect(formatClock(1440)).toBe('24:00');
    expect(formatClock(545)).toBe('09:05');
  });

  it('zero-pads valid clocks and leaves other values unchanged', () => {
    expect(normalizeClock('9:05')).toBe('09:05');
    expect(normalizeClock('17:30')).toBe('17:30');
    for (const value of ['2026-10-02T10:00:00Z', '24:00', '', null, undefined]) expect(normalizeClock(value)).toBe(value);
  });

  it('accepts only real calendar dates', () => {
    expect(dayNumber('1970-01-02')).toBe(1);
    for (const value of ['2026-02-30', '2026-13-01', '2026-1-01', '0099-01-01', null]) expect(dayNumber(value)).toBeNull();
  });

  it('reads the current wall clock in the shop timezone, falling back to UTC', () => {
    expect(zonedNow('America/Argentina/Buenos_Aires', now)).toEqual({ day: dayNumber('2026-10-01'), minutes: 9 * 60 });
    expect(zonedNow(undefined, now)).toEqual({ day: dayNumber('2026-10-01'), minutes: 12 * 60 });
    expect(zonedNow('Not/AZone', now)).toEqual({ day: dayNumber('2026-10-01'), minutes: 12 * 60 });
    expect(zonedNow('Pacific/Kiritimati', new Date('2026-10-01T23:30:00Z'))).toEqual({ day: dayNumber('2026-10-02'), minutes: 13 * 60 + 30 });
  });

  it('sums line durations, counting negative stored durations as zero', () => {
    expect(linesDurationMinutes([{ durationMinutes: 30 }, { durationMinutes: 45 }, {}])).toBe(75);
    expect(linesDurationMinutes([{ durationMinutes: 30 }, { durationMinutes: -600 }])).toBe(30);
    expect(linesDurationMinutes(null)).toBe(0);
  });

  it('derives the stored end time from the start time and line durations only', () => {
    expect(bookingEndTime('9:00', [{ durationMinutes: 30 }, { durationMinutes: 45 }])).toBe('10:15');
    expect(bookingEndTime('14:30', [])).toBe('14:30');
    expect(bookingEndTime('10:00', [{ durationMinutes: 30 }, { durationMinutes: -600 }])).toBe('10:30');
    expect(bookingEndTime('23:30', [{ durationMinutes: 30 }])).toBe('24:00');
    for (const startTime of [null, undefined, '24:00', '10:00:00']) expect(bookingEndTime(startTime, [{ durationMinutes: 30 }])).toBeNull();
  });
});

describe('findLineViolation', () => {
  it('accepts lines with exactly one reference and a whole, non-negative or missing duration', () => {
    expect(findLineViolation([{ service: 'cut', durationMinutes: 30 }, { bundle: { id: 'combo' }, durationMinutes: 0 }, { service: 'cut', bundle: null }])).toBeNull();
    expect(findLineViolation(null)).toBeNull();
  });

  it('rejects lines without a reference or with both references', () => {
    for (const line of [{ price: 0, durationMinutes: 15 }, { service: null, bundle: null }, { service: 'cut', bundle: 'combo' }]) {
      expect(findLineViolation([{ service: 'cut', durationMinutes: 30 }, line])?.code).toBe('INVALID_BOOKING_LINE');
    }
  });

  it('rejects negative or fractional durations, even on referenced lines', () => {
    for (const durationMinutes of [-600, -1, 1.5, Number.NaN, '30']) {
      expect(findLineViolation([{ service: 'cut', durationMinutes }])?.code).toBe('INVALID_BOOKING_LINE');
    }
  });
});

describe('findScheduleViolation', () => {
  it('accepts a slot inside hours and the advance window', () => {
    expect(check('2026-10-02', '10:00')).toBeNull();
  });

  it('rejects malformed dates and times', () => {
    expect(check('2026-02-30', '10:00')).toBe('INVALID_BOOKING_TIME');
    expect(check('2026-10-02', '25:00')).toBe('INVALID_BOOKING_TIME');
  });

  it('rejects past slots and slots earlier than now + minAdvanceHours', () => {
    expect(check('2020-01-01', '10:00')).toBe('BOOKING_OUTSIDE_ADVANCE_WINDOW');
    expect(check('2026-10-01', '10:30')).toBe('BOOKING_OUTSIDE_ADVANCE_WINDOW');
    expect(check('2026-10-01', '11:00')).toBeNull();
    expect(check('2026-10-01', '08:00', 30, { barbershop: { ...shop, minAdvanceHours: 0, businessHours: [] } })).toBe('BOOKING_OUTSIDE_ADVANCE_WINDOW');
  });

  it('skips only the past and advance rules for a booking that keeps its date and time', () => {
    const kept = { checkAdvanceWindow: false };
    expect(check('2026-10-01', '09:00', 30, kept)).toBeNull();
    expect(check('2026-11-02', '10:00', 30, kept)).toBeNull();
    expect(check('2026-10-01', '12:30', 30, kept)).toBe('BOOKING_OUTSIDE_HOURS');
    expect(check('2026-10-01', '9:0', 30, kept)).toBe('INVALID_BOOKING_TIME');
  });

  it('rejects slots beyond maxAdvanceDays', () => {
    expect(check('2026-10-31', '10:00')).toBeNull();
    expect(check('2026-11-02', '10:00')).toBe('BOOKING_OUTSIDE_ADVANCE_WINDOW');
    expect(check('2031-10-02', '10:00', 30, { barbershop: { ...shop, maxAdvanceDays: null } })).toBeNull();
  });

  it('rejects closed days, early starts, breaks and endings after closing (buffer included)', () => {
    expect(check('2026-10-04', '10:00')).toBe('BOOKING_OUTSIDE_HOURS');
    expect(check('2026-10-02', '03:00')).toBe('BOOKING_OUTSIDE_HOURS');
    expect(check('2026-10-02', '12:20')).toBeNull();
    expect(check('2026-10-02', '12:30')).toBe('BOOKING_OUTSIDE_HOURS');
    expect(check('2026-10-02', '13:30')).toBe('BOOKING_OUTSIDE_HOURS');
    expect(check('2026-10-02', '14:00')).toBeNull();
    expect(check('2026-10-02', '17:20')).toBeNull();
    expect(check('2026-10-02', '17:45', 60)).toBe('BOOKING_OUTSIDE_HOURS');
  });

  it("narrows the shop's hours with the professional's own row for the weekday", () => {
    // Friday 2026-10-02: the shop opens 09:00-18:00, the professional 07:00-12:00.
    const professional = { businessHours: [{ dayOfWeek: 5, openTime: '07:00', closeTime: '12:00', isClosed: false }] };
    expect(check('2026-10-02', '08:00', 30, { professional })).toBe('BOOKING_OUTSIDE_HOURS');
    expect(check('2026-10-02', '09:00', 30, { professional })).toBeNull();
    expect(check('2026-10-02', '11:20', 30, { professional })).toBeNull();
    expect(check('2026-10-02', '11:30', 30, { professional })).toBe('BOOKING_OUTSIDE_HOURS');
    expect(check('2026-10-02', '15:00', 30, { professional })).toBe('BOOKING_OUTSIDE_HOURS');
    expect(check('2026-10-05', '15:00', 30, { professional })).toBeNull();
    expect(hoursForDay(shop, professional, 5)).toEqual({ isClosed: false, open: 540, close: 720, breaks: [[780, 840]] });
    expect(hoursForDay(shop, professional, 1)).toEqual({ isClosed: false, open: 540, close: 1080, breaks: [[780, 840]] });
    expect(hoursForDay({ businessHours: [] }, professional, 1)).toBeNull();
  });

  it('closes a day that either the shop or the professional closes', () => {
    // Sunday 2026-10-04 is closed for the shop, even though the professional's default row opens it.
    const openEveryDay = { businessHours: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, openTime: '09:00', closeTime: '18:00', isClosed: false })) };
    expect(check('2026-10-04', '10:00', 30, { professional: openEveryDay })).toBe('BOOKING_OUTSIDE_HOURS');
    expect(check('2026-10-02', '10:00', 30, { professional: openEveryDay })).toBeNull();
    const offOnFriday = { businessHours: [{ dayOfWeek: 5, openTime: '09:00', closeTime: '18:00', isClosed: true }] };
    expect(check('2026-10-02', '10:00', 30, { professional: offOnFriday })).toBe('BOOKING_OUTSIDE_HOURS');
    const disjoint = { businessHours: [{ dayOfWeek: 5, openTime: '06:00', closeTime: '08:00', isClosed: false }] };
    expect(check('2026-10-02', '07:00', 30, { professional: disjoint })).toBe('BOOKING_OUTSIDE_HOURS');
    expect(check('2026-10-02', '10:00', 30, { professional: disjoint })).toBe('BOOKING_OUTSIDE_HOURS');
  });

  it("applies both the shop's and the professional's breaks", () => {
    const professional = { businessHours: [{ dayOfWeek: 5, openTime: '09:00', closeTime: '18:00', breakStartTime: '10:00', breakEndTime: '10:30' }] };
    expect(check('2026-10-02', '10:00', 30, { professional })).toBe('BOOKING_OUTSIDE_HOURS');
    expect(check('2026-10-02', '13:00', 30, { professional })).toBe('BOOKING_OUTSIDE_HOURS');
    expect(check('2026-10-02', '11:00', 30, { professional })).toBeNull();
  });

  it("uses the professional's row alone when the shop has none for the weekday", () => {
    const professional = { businessHours: [{ dayOfWeek: 5, openTime: '10:00', closeTime: '12:00' }] };
    const noRows = { ...shop, businessHours: [] };
    expect(check('2026-10-02', '09:00', 30, { barbershop: noRows, professional })).toBe('BOOKING_OUTSIDE_HOURS');
    expect(check('2026-10-02', '10:00', 30, { barbershop: noRows, professional })).toBeNull();
  });

  it('accepts a closing time of 24:00 and bookings that end at midnight', () => {
    const lateShop = { ...shop, bufferMinutes: 0, businessHours: [{ dayOfWeek: 5, openTime: '09:00', closeTime: '24:00' }] };
    expect(check('2026-10-02', '23:30', 30, { barbershop: lateShop })).toBeNull();
    expect(check('2026-10-02', '23:45', 30, { barbershop: lateShop })).toBe('BOOKING_OUTSIDE_HOURS');
  });

  it('does not restrict hours for a weekday without a row, but the booking must end that day', () => {
    const unrestricted = { ...shop, businessHours: [{ dayOfWeek: 1, openTime: '09:00', closeTime: '18:00' }] };
    expect(check('2026-10-02', '06:00', 30, { barbershop: unrestricted })).toBeNull();
    expect(check('2026-10-02', '23:30', 60, { barbershop: unrestricted })).toBe('BOOKING_OUTSIDE_HOURS');
  });
});

describe('findOverlappingBooking', () => {
  const taken = { startTime: '10:00', endTime: '10:30', professional: 'p1' };
  const overlap = (startTime, durationMinutes, professionalId, bookings = [taken], bufferMinutes = 10) => findOverlappingBooking({
    startTime, durationMinutes, professionalId, bufferMinutes, bookings,
  });

  it('finds partial and exact overlaps for the same professional', () => {
    expect(overlap('10:00', 30, 'p1')).toBe(taken);
    expect(overlap('10:15', 30, 'p1')).toBe(taken);
    expect(overlap('09:30', 60, 'p1')).toBe(taken);
  });

  it('keeps bufferMinutes between consecutive bookings', () => {
    expect(overlap('10:35', 30, 'p1')).toBe(taken);
    expect(overlap('10:40', 30, 'p1')).toBeNull();
    expect(overlap('09:30', 25, 'p1')).toBe(taken);
    expect(overlap('09:20', 30, 'p1')).toBeNull();
  });

  it('lets other professionals book the same time', () => {
    expect(overlap('10:00', 30, 'p2')).toBeNull();
  });

  it('treats bookings without a professional as holding the whole shop', () => {
    expect(overlap('10:00', 30, null)).toBe(taken);
    const shopWide = { startTime: '10:00', endTime: '10:30', professional: null };
    expect(overlap('10:00', 30, 'p2', [shopWide])).toBe(shopWide);
    expect(blocksProfessional('p1', 'p2')).toBe(false);
  });

  it('reads a stored end time of 24:00 as midnight', () => {
    const lastOfDay = { startTime: '23:30', endTime: '24:00', professional: 'p1' };
    expect(overlap('23:40', 20, 'p1', [lastOfDay], 0)).toBe(lastOfDay);
    expect(overlap('23:00', 30, 'p1', [lastOfDay], 0)).toBeNull();
  });

  it('collides empty ranges at a shared start and ignores malformed stored times', () => {
    expect(overlap('10:00', 0, 'p1', [taken], 0)).toBe(taken);
    expect(overlap('10:30', 0, 'p1', [taken], 0)).toBeNull();
    expect(overlap('10:00', 30, 'p1', [{ startTime: 'bad', endTime: '11:00', professional: 'p1' }])).toBeNull();
    expect(rangesOverlap(600, 600, 600, 630)).toBe(true);
  });
});

describe('bookingSlotChange', () => {
  const idOf = (value) => (value == null ? null : String(value.id ?? value));
  const stored = {
    state: 'CONFIRMED', scheduledDate: '2026-10-02', startTime: '9:00', barbershop: 'shop', professional: 'p1',
    lines: [{ service: 'cut', durationMinutes: 30, price: 25 }],
  };
  const change = (next) => bookingSlotChange(stored, { ...stored, ...next }, idOf);

  it('ignores resent values that only differ in form, and changes outside the slot', () => {
    expect(change({ startTime: '09:00', professional: { id: 'p1' }, barbershop: { id: 'shop' }, notes: 'x' })).toEqual({ moved: false, changed: false });
    expect(change({ lines: [{ service: { id: 'cut' }, durationMinutes: 30, price: 99 }] })).toEqual({ moved: false, changed: false });
  });

  it('marks a new date or time as moved', () => {
    expect(change({ scheduledDate: '2026-10-03' })).toEqual({ moved: true, changed: true });
    expect(change({ startTime: '09:30' })).toEqual({ moved: true, changed: true });
    expect(bookingSlotChange({ ...stored, state: 'COMPLETED' }, stored, idOf)).toEqual({ moved: true, changed: true });
  });

  it('marks professional, shop and line reference or duration changes as changed in place', () => {
    for (const next of [
      { professional: 'p2' }, { professional: null }, { barbershop: 'other' },
      { lines: [{ service: 'cut', durationMinutes: 45 }] }, { lines: [{ bundle: 'cut', durationMinutes: 30 }] },
      { lines: [...stored.lines, { service: 'beard', durationMinutes: 15 }] }, { lines: [] },
    ]) expect(change(next)).toEqual({ moved: false, changed: true });
  });
});
