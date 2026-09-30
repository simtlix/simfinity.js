import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

class SimfinityError extends Error {
  constructor(message, code, status) {
    super(message);
    this.extensions = { code, status };
  }
}

vi.mock('@simtlix/simfinity-js', () => ({
  default: {},
  SimfinityError,
  getType: vi.fn(),
  getModel: vi.fn(),
  registerMutation: vi.fn(),
}));

vi.mock('../auth/permissions.js', () => ({ hasAnyRole: () => false }));

const simfinity = await import('@simtlix/simfinity-js');
const { bookingController, findSlotHoldingBookings } = await import('../types/booking.controller.js');
const { listBusyRanges } = await import('../types/customMutations.js');

// bookingAvailability validates ObjectIds, so the shop uses a real one.
const SHOP = '64b7f0c2a1b2c3d4e5f60718';
const hours = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek, openTime: '09:00', closeTime: '18:00', isClosed: dayOfWeek === 0, breakStartTime: '13:00', breakEndTime: '14:00',
}));

/** Mongoose-like query chain resolving to `result`. */
const chain = (result) => {
  const query = { select: () => query, session: () => query, lean: () => Promise.resolve(result) };
  return query;
};
const matches = (row, filter) => Object.entries(filter).every(([key, value]) => (value?.$in
  ? value.$in.map(String).includes(String(row[key]))
  : String(row[key]) === String(value)));

let data;
let calls;
beforeEach(() => {
  // 2026-10-01 12:00 UTC is Thursday 09:00 in Buenos Aires.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
  calls = [];
  data = {
    barbershop: [{
      _id: SHOP, state: 'APPROVED', timezone: 'America/Argentina/Buenos_Aires', bufferMinutes: 0, minAdvanceHours: 1, maxAdvanceDays: 30, businessHours: hours,
    }, { _id: 'other-shop', state: 'APPROVED' }],
    professional: [{ _id: 'p1', barbershop: SHOP }, { _id: 'p2', barbershop: SHOP }, { _id: 'foreign', barbershop: 'other-shop' }],
    service: [{ _id: 'cut', durationMinutes: 30 }, { _id: 'color', durationMinutes: 60 }],
    bundle: [{ _id: 'combo', totalDurationMinutes: 90 }],
    booking: [
      { _id: 'held', barbershop: SHOP, professional: 'p1', scheduledDate: '2026-10-02', startTime: '10:00', endTime: '10:30', state: 'CONFIRMED', lines: [{ service: 'cut', durationMinutes: 30 }] },
      { _id: 'cancelled', barbershop: SHOP, professional: 'p1', scheduledDate: '2026-10-02', startTime: '15:00', endTime: '15:30', state: 'CANCELLED_BY_CLIENT' },
      { _id: 'mine', barbershop: SHOP, professional: 'p1', scheduledDate: '2026-10-02', startTime: '11:00', endTime: '11:30', state: 'CONFIRMED', lines: [{ service: 'cut', durationMinutes: 30 }] },
    ],
  };
  simfinity.getType.mockImplementation((name) => name);
  simfinity.getModel.mockImplementation((name) => ({
    findById: (id) => { calls.push(`${name}.findById`); return chain(data[name].find((row) => row._id === String(id)) ?? null); },
    find: (filter) => { calls.push(`${name}.find`); return chain(data[name].filter((row) => matches(row, filter))); },
    updateOne: vi.fn(async (filter, update, options) => { calls.push({ lock: name, filter, update, options }); }),
    updateMany: vi.fn(async (filter, update, options) => { calls.push({ lock: name, filter, update, options, many: true }); }),
  }));
});
afterEach(() => vi.useRealTimers());

const session = { id: 'session' };
const create = (input) => {
  const doc = { _id: 'new', barbershop: SHOP, professional: 'p2', scheduledDate: '2026-10-02', startTime: '10:00', state: 'CONFIRMED', lines: [{ service: 'cut', price: 25, durationMinutes: 30 }], ...input };
  return bookingController.onSaving(doc, { barbershop: { id: doc.barbershop } }, session, { user: { id: 'client', roles: ['CLIENT'] } }).then(() => doc);
};
const rejection = (promise) => promise.then(() => null, (error) => error.extensions?.code ?? error.message);

describe('booking create slot validation', () => {
  it('rejects an exact or partial overlap with a confirmed booking of the same professional', async () => {
    expect(await rejection(create({ professional: 'p1' }))).toBe('BOOKING_SLOT_UNAVAILABLE');
    expect(await rejection(create({ professional: 'p1', startTime: '10:15' }))).toBe('BOOKING_SLOT_UNAVAILABLE');
  });

  it('accepts the same time for another professional and ignores cancelled bookings', async () => {
    await expect(create({ professional: 'p2' })).resolves.toMatchObject({ endTime: '10:30' });
    await expect(create({ professional: 'p1', startTime: '15:00' })).resolves.toMatchObject({ endTime: '15:30' });
  });

  it('holds the whole shop for bookings without a professional', async () => {
    expect(await rejection(create({ professional: undefined }))).toBe('BOOKING_SLOT_UNAVAILABLE');
    data.booking.push({ _id: 'shop-wide', barbershop: SHOP, scheduledDate: '2026-10-02', startTime: '16:00', endTime: '16:30', state: 'CONFIRMED' });
    expect(await rejection(create({ professional: 'p2', startTime: '16:00' }))).toBe('BOOKING_SLOT_UNAVAILABLE');
  });

  it('derives durations and endTime from the catalog instead of client durations', async () => {
    expect(await rejection(create({ professional: 'p1', startTime: '09:45', lines: [{ service: 'cut', price: 25, durationMinutes: 0 }] }))).toBe('BOOKING_SLOT_UNAVAILABLE');
    const doc = await create({ startTime: '14:00', lines: [{ service: 'cut', price: 1, durationMinutes: 5 }, { bundle: 'combo', price: 2, durationMinutes: 5 }] });
    expect(doc.lines.map((line) => line.durationMinutes)).toEqual([30, 90]);
    expect(doc.endTime).toBe('16:00');
    expect(doc.totalPrice).toBe(3);
  });

  it('keeps the captured duration of lines whose reference does not resolve', async () => {
    const doc = await create({ startTime: '14:00', lines: [{ service: 'missing', price: 1, durationMinutes: 45 }, { bundle: 'missing', price: 2, durationMinutes: 15 }] });
    expect(doc.endTime).toBe('15:00');
  });

  it('rejects lines without exactly one reference or with negative durations before checking the slot', async () => {
    for (const lines of [
      [{ service: 'cut', price: 25, durationMinutes: 30 }, { price: 0, durationMinutes: -600 }],
      [{ durationMinutes: -5 }],
      [{ service: 'missing', price: 0, durationMinutes: -100 }],
      [{ service: 'cut', durationMinutes: -60 }],
      [{ service: 'cut', bundle: 'combo' }],
    ]) {
      expect(await rejection(create({ professional: 'p1', startTime: '10:10', lines }))).toBe('INVALID_BOOKING_LINE');
    }
    expect(await rejection(create({ startTime: '17:45', lines: [{ service: 'cut' }, { service: 'cut', durationMinutes: -60 }] }))).toBe('INVALID_BOOKING_LINE');
    expect(calls.filter((call) => call.lock)).toEqual([]);
  });

  it('rejects past, too-soon, too-far, closed-day, out-of-hours and break slots', async () => {
    expect(await rejection(create({ scheduledDate: '2020-01-01' }))).toBe('BOOKING_OUTSIDE_ADVANCE_WINDOW');
    expect(await rejection(create({ scheduledDate: '2026-10-01', startTime: '09:30' }))).toBe('BOOKING_OUTSIDE_ADVANCE_WINDOW');
    expect(await rejection(create({ scheduledDate: '2031-10-02' }))).toBe('BOOKING_OUTSIDE_ADVANCE_WINDOW');
    expect(await rejection(create({ scheduledDate: '2026-10-04' }))).toBe('BOOKING_OUTSIDE_HOURS');
    expect(await rejection(create({ startTime: '03:00' }))).toBe('BOOKING_OUTSIDE_HOURS');
    expect(await rejection(create({ startTime: '13:00' }))).toBe('BOOKING_OUTSIDE_HOURS');
    expect(await rejection(create({ startTime: '17:45', lines: [{ service: 'color', durationMinutes: 60 }] }))).toBe('BOOKING_OUTSIDE_HOURS');
    expect(await rejection(create({ startTime: '10:00:00' }))).toBe('INVALID_BOOKING_TIME');
  });

  it('rejects a professional from another barbershop', async () => {
    expect(await rejection(create({ professional: 'foreign' }))).toBe('INVALID_BOOKING_PROFESSIONAL');
  });

  it('stores start times as zero-padded HH:mm', async () => {
    await expect(create({ startTime: '9:30' })).resolves.toMatchObject({ startTime: '09:30', endTime: '10:00' });
  });

  it('stores the derived endTime instead of the one the client sends, with or without lines', async () => {
    await expect(create({ endTime: '10:00' })).resolves.toMatchObject({ endTime: '10:30' });
    const stretched = await create({ professional: 'p1', startTime: '14:30', endTime: '17:30', lines: [] });
    expect(stretched.endTime).toBe('14:30');
    await expect(create({ professional: 'p1', startTime: '12:00', endTime: '23:59', lines: undefined })).resolves.toMatchObject({ endTime: '12:00' });
    // The stored, server-derived end is what later overlap checks read.
    data.booking.push({ _id: 'stretched', barbershop: SHOP, professional: 'p1', scheduledDate: '2026-10-02', startTime: stretched.startTime, endTime: stretched.endTime, state: 'CONFIRMED' });
    await expect(create({ professional: 'p1', startTime: '15:00' })).resolves.toMatchObject({ endTime: '15:30' });
  });

  it("narrows the shop's hours with the professional's, so a shop's closed day stays closed", async () => {
    // Sunday 2026-10-04 is closed for the shop; p2's own hours open every day.
    data.professional[1].businessHours = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, openTime: '09:00', closeTime: '18:00', isClosed: false }));
    expect(await rejection(create({ scheduledDate: '2026-10-04' }))).toBe('BOOKING_OUTSIDE_HOURS');
    data.professional[1].businessHours = [{ dayOfWeek: 5, openTime: '12:00', closeTime: '16:00', isClosed: false }];
    expect(await rejection(create({ startTime: '10:00' }))).toBe('BOOKING_OUTSIDE_HOURS');
    await expect(create({ startTime: '12:00' })).resolves.toMatchObject({ endTime: '12:30' });
  });

  it('rejects a nested create stored in another shop than the one it named and checked', async () => {
    const oid = (hex) => ({ toHexString: () => hex });
    await expect(bookingController.onSaved({ barbershop: oid(SHOP) }, { barbershop: { id: SHOP } })).resolves.toBeUndefined();
    await expect(bookingController.onSaved({ barbershop: oid(SHOP) }, { barbershop: { id: SHOP.toUpperCase() } })).resolves.toBeUndefined();
    expect(await rejection(bookingController.onSaved({ barbershop: oid('other-shop') }, { barbershop: { id: SHOP } }))).toBe('INVALID_BOOKING_BARBERSHOP');
  });

  it('requires a date and a start time for a new confirmed booking', async () => {
    expect(await rejection(create({ scheduledDate: undefined, professional: 'p1' }))).toBe('INVALID_BOOKING_TIME');
    expect(await rejection(create({ scheduledDate: '2020-01-01', startTime: undefined }))).toBe('INVALID_BOOKING_TIME');
  });
});

describe('booking schedule serialization', () => {
  it('writes the professional document in the session before reading overlapping bookings', async () => {
    await create({ startTime: '14:00' });
    const lock = calls.findIndex((call) => call.lock);
    expect(calls[lock]).toMatchObject({ lock: 'professional', filter: { _id: 'p2' }, options: { session, strict: false } });
    expect(Object.values(calls[lock].update.$inc)).toEqual([1]);
    expect(calls.indexOf('booking.find')).toBeGreaterThan(lock);
  });

  it('writes the shop and all its professionals for a booking without a professional', async () => {
    await create({ professional: undefined, startTime: '14:00' });
    expect(calls.filter((call) => call.lock)).toMatchObject([
      { lock: 'barbershop', filter: { _id: SHOP } },
      { lock: 'professional', filter: { barbershop: SHOP }, many: true },
    ]);
  });

  it('keeps transient write conflicts retryable but reports them as a clean domain error', async () => {
    simfinity.getModel.mockImplementation((name) => ({
      findById: (id) => chain(data[name].find((row) => row._id === String(id)) ?? null),
      find: (filter) => chain(data[name].filter((row) => matches(row, filter))),
      updateOne: async () => { throw Object.assign(new Error('WriteConflict'), { errorLabels: ['TransientTransactionError'] }); },
    }));
    const started = performance.now();
    const error = await create({ startTime: '14:00' }).catch((caught) => caught);
    expect(error.extensions.code).toBe('BOOKING_SCHEDULE_BUSY');
    expect(error.errorLabels).toContain('TransientTransactionError');
    // A short random pause before the runtime's immediate retry spreads concurrent attempts apart.
    expect(performance.now() - started).toBeGreaterThanOrEqual(19);
  });
});

describe('booking update slot validation', () => {
  const update = (id, changes) => bookingController.onUpdating(id, changes, session).then(() => changes);

  it('rejects moving a booking onto another confirmed booking', async () => {
    expect(await rejection(update('mine', { id: 'mine', startTime: '10:00' }))).toBe('BOOKING_SLOT_UNAVAILABLE');
    expect(await rejection(update('mine', { id: 'mine', professional: 'p2', startTime: '13:30' }))).toBe('BOOKING_OUTSIDE_HOURS');
  });

  it('excludes the booking itself when it moves within its own slot', async () => {
    await expect(update('mine', { id: 'mine', startTime: '11:15' })).resolves.toMatchObject({ endTime: '11:45' });
  });

  it('excludes the same booking when its ID uses uppercase hex', async () => {
    const id = '64b7f0c2a1b2c3d4e5f60729';
    data.booking.find((row) => row._id === 'mine')._id = id;
    const rows = await findSlotHoldingBookings(SHOP, '2026-10-02', session, id.toUpperCase());
    expect(rows.map((row) => row.startTime)).toEqual(['10:00']);
  });

  it('revalidates line replacements with catalog durations', async () => {
    const changes = await rejection(update('mine', { id: 'mine', lines: [{ service: 'color', price: 1, durationMinutes: 0 }] }));
    expect(changes).toBeNull();
    expect(await rejection(update('held', { id: 'held', lines: [{ bundle: 'combo', durationMinutes: 0 }] }))).toBe('BOOKING_SLOT_UNAVAILABLE');
  });

  it('rejects replacement lines without a reference or with negative durations', async () => {
    expect(await rejection(update('mine', { id: 'mine', startTime: '10:10', lines: [{ service: 'cut' }, { price: 0, durationMinutes: -600 }] }))).toBe('INVALID_BOOKING_LINE');
    expect(await rejection(update('mine', { id: 'mine', lines: [{ service: 'cut', durationMinutes: -5 }] }))).toBe('INVALID_BOOKING_LINE');
  });

  it('counts negative durations stored by earlier versions as zero when a booking moves', async () => {
    data.booking.push({
      _id: 'legacy', barbershop: SHOP, professional: 'p1', scheduledDate: '2026-10-02', startTime: '15:00', endTime: '05:00', state: 'CONFIRMED',
      lines: [{ service: 'cut', durationMinutes: 30 }, { durationMinutes: -600 }],
    });
    expect(await rejection(update('legacy', { id: 'legacy', startTime: '10:10' }))).toBe('BOOKING_SLOT_UNAVAILABLE');
    await expect(update('legacy', { id: 'legacy', startTime: '16:00' })).resolves.toMatchObject({ endTime: '16:30' });
  });

  it('requires a date and time when an update moves a booking, but not for legacy bookings kept in place', async () => {
    expect(await rejection(update('mine', { id: 'mine', $unset: { scheduledDate: '' } }))).toBe('INVALID_BOOKING_TIME');
    data.booking.push({ _id: 'undated', barbershop: SHOP, professional: 'p1', startTime: '10:00', state: 'CONFIRMED', lines: [{ service: 'cut', durationMinutes: 30 }] });
    await expect(update('undated', { id: 'undated', lines: [{ service: 'color', price: 40 }] })).resolves.toMatchObject({ endTime: '11:00' });
    expect(await rejection(update('undated', { id: 'undated', startTime: '12:00' }))).toBe('INVALID_BOOKING_TIME');
  });

  it('replaces an endTime sent or unset by the client with the derived one', async () => {
    for (const endTime of ['10:00', '16:00', '23:59']) {
      const changes = await update('held', { id: 'held', endTime });
      expect(changes.endTime).toBe('10:30');
    }
    const unset = await update('held', { id: 'held', $unset: { endTime: '' } });
    expect(unset).toEqual({ id: 'held', endTime: '10:30' });
    await expect(update('mine', { id: 'mine', startTime: '11:15', endTime: '11:15' })).resolves.toMatchObject({ endTime: '11:45' });
    // An endTime-only update does not move the booking, so nothing is rechecked or locked.
    expect(calls.filter((call) => call.lock && call.filter._id === 'p1').length).toBe(1);
  });

  it('keeps derived totals when the client also unsets them', async () => {
    const changes = await update('mine', { id: 'mine', lines: [{ service: 'cut', price: 5 }], $unset: { totalPrice: '', endTime: '' } });
    expect(changes).toMatchObject({ totalPrice: 5, endTime: '11:30' });
    expect(changes.$unset).toBeUndefined();
    const other = await update('mine', { id: 'mine', lines: [{ service: 'cut', price: 5 }], $unset: { notes: '', endTime: '' } });
    expect(other.$unset).toEqual({ notes: '' });
  });

  it('requires an approved shop to move a booking or place it in another shop, not to edit it in place', async () => {
    data.barbershop[0].state = 'SUSPENDED';
    expect(await rejection(update('mine', { id: 'mine', startTime: '15:00' }))).toBe('Barbershop is not available for booking');
    await expect(update('mine', { id: 'mine', lines: [{ service: 'color', price: 40 }] })).resolves.toMatchObject({ endTime: '12:00' });
    data.barbershop[0].state = 'APPROVED';
    data.barbershop.push({ _id: 'suspended-shop', state: 'SUSPENDED' });
    expect(await rejection(update('mine', { id: 'mine', barbershop: 'suspended-shop', $unset: { professional: '' } }))).toBe('Barbershop is not available for booking');
  });

  it('does not validate or lock state transitions and unrelated updates', async () => {
    await update('held', { id: 'held', state: 'COMPLETED' });
    await update('held', { id: 'held', notes: 'x' });
    expect(calls.filter((call) => call.lock || call === 'booking.find')).toEqual([]);
  });

  it('normalizes a new start time to zero-padded HH:mm', async () => {
    await expect(update('mine', { id: 'mine', startTime: '9:00' })).resolves.toMatchObject({ startTime: '09:00', endTime: '09:30' });
  });

  describe('a booking that has already started', () => {
    // 09:20 in Buenos Aires: the 09:00-09:30 booking is in progress and inside minAdvanceHours.
    const oid = (hex) => ({ toHexString: () => hex, toString: () => hex });
    beforeEach(() => {
      vi.setSystemTime(new Date('2026-10-01T12:20:00Z'));
      data.booking.push({
        _id: 'started', barbershop: oid(SHOP), professional: oid('p2'), scheduledDate: '2026-10-01', startTime: '09:00', endTime: '09:30',
        state: 'CONFIRMED', lines: [{ _id: oid('line'), service: oid('cut'), price: 25, durationMinutes: 30 }],
      });
    });

    it('saves an edit form that resends the unchanged date, time and professional', async () => {
      const changes = await update('started', { id: 'started', scheduledDate: '2026-10-01', startTime: '09:00', professional: 'p2', notes: 'Running late' });
      expect(changes).toMatchObject({ startTime: '09:00', endTime: '09:30' });
      expect(calls.filter((call) => call.lock || call === 'booking.find')).toEqual([]);
    });

    it('resaves unchanged lines without rechecking the slot', async () => {
      await update('started', { id: 'started', lines: [{ service: 'cut', price: 25, durationMinutes: 30 }] });
      expect(calls.filter((call) => call.lock || call === 'booking.find')).toEqual([]);
    });

    it('adds a line after checking hours and overlaps but not the advance window', async () => {
      const changes = await update('started', { id: 'started', lines: [{ service: 'cut', price: 25 }, { service: 'color', price: 40 }] });
      expect(changes).toMatchObject({ endTime: '10:30', totalPrice: 65 });
      expect(calls.filter((call) => call.lock)).toHaveLength(1);
      data.booking.push({ _id: 'next', barbershop: SHOP, professional: 'p2', scheduledDate: '2026-10-01', startTime: '10:00', endTime: '10:30', state: 'CONFIRMED' });
      expect(await rejection(update('started', { id: 'started', lines: [{ service: 'cut' }, { service: 'color' }] }))).toBe('BOOKING_SLOT_UNAVAILABLE');
      expect(await rejection(update('started', { id: 'started', lines: [{ bundle: 'combo' }, { bundle: 'combo' }, { bundle: 'combo' }] }))).toBe('BOOKING_OUTSIDE_HOURS');
    });

    it('still applies the advance window when the booking moves to another time', async () => {
      expect(await rejection(update('started', { id: 'started', startTime: '10:00' }))).toBe('BOOKING_OUTSIDE_ADVANCE_WINDOW');
      await expect(update('started', { id: 'started', startTime: '11:00' })).resolves.toMatchObject({ endTime: '11:30' });
    });
  });
});

describe('bookingAvailability', () => {
  it('returns only times and professional IDs of confirmed bookings for the date', async () => {
    const ranges = await listBusyRanges({ barbershopId: SHOP, date: '2026-10-02' }, session);
    expect(ranges).toEqual([
      { startTime: '10:00', endTime: '10:30', professionalId: 'p1' },
      { startTime: '11:00', endTime: '11:30', professionalId: 'p1' },
    ]);
  });

  it('orders ranges by clock time, including unpadded stored times', async () => {
    data.booking.push({ _id: 'legacy', barbershop: SHOP, professional: 'p2', scheduledDate: '2026-10-02', startTime: '9:00', endTime: '09:30', state: 'CONFIRMED' });
    const ranges = await listBusyRanges({ barbershopId: SHOP, date: '2026-10-02' }, session);
    expect(ranges.map((range) => range.startTime)).toEqual(['9:00', '10:00', '11:00']);
  });

  it('filters by professional while keeping shop-wide bookings', async () => {
    data.booking.push({ _id: 'shop-wide', barbershop: SHOP, scheduledDate: '2026-10-02', startTime: '16:00', endTime: '16:30', state: 'CONFIRMED' });
    expect(await listBusyRanges({ barbershopId: SHOP, date: '2026-10-02', professionalId: 'p2' }, session))
      .toEqual([{ startTime: '16:00', endTime: '16:30', professionalId: null }]);
  });

  it('rejects malformed barbershop IDs with a domain error instead of a cast error', async () => {
    const error = await listBusyRanges({ barbershopId: 'not-an-id', date: '2026-10-02' }, session).catch((caught) => caught);
    expect(error.extensions.code).toBe('NOT_VALID_ID');
    const excluded = await listBusyRanges({ barbershopId: SHOP, date: '2026-10-02', excludeBookingId: 'mine' }, session).catch((caught) => caught);
    expect(excluded.extensions.code).toBe('NOT_VALID_ID');
    expect(calls).toEqual([]);
  });

  it("leaves out the caller's own booking when asked, but never another client's", async () => {
    const own = '64b7f0c2a1b2c3d4e5f60720';
    const others = '64b7f0c2a1b2c3d4e5f60721';
    data.booking.push(
      { _id: own, client: 'client', barbershop: SHOP, professional: 'p2', scheduledDate: '2026-10-02', startTime: '12:00', endTime: '12:30', state: 'CONFIRMED' },
      { _id: others, client: 'someone', barbershop: SHOP, professional: 'p2', scheduledDate: '2026-10-02', startTime: '15:00', endTime: '15:30', state: 'CONFIRMED' },
    );
    const times = async (excludeBookingId, user) => (await listBusyRanges({ barbershopId: SHOP, date: '2026-10-02', excludeBookingId }, session, user && { user }))
      .map((range) => range.startTime);
    expect(await times(own, { id: 'client' })).toEqual(['10:00', '11:00', '15:00']);
    expect(await times(others, { id: 'client' })).toEqual(['10:00', '11:00', '12:00', '15:00']);
    expect(await times(own, undefined)).toEqual(['10:00', '11:00', '12:00', '15:00']);
  });

  it('matches uppercase professional IDs to their stored canonical IDs', async () => {
    const professionalId = '64b7f0c2a1b2c3d4e5f60730';
    data.booking.filter((row) => row.professional === 'p1').forEach((row) => { row.professional = professionalId; });
    expect(await listBusyRanges({ barbershopId: SHOP, date: '2026-10-02', professionalId: professionalId.toUpperCase() }, session))
      .toEqual([
        { startTime: '10:00', endTime: '10:30', professionalId },
        { startTime: '11:00', endTime: '11:30', professionalId },
      ]);
  });

  it('rejects malformed dates and unavailable barbershops', async () => {
    expect(await rejection(listBusyRanges({ barbershopId: SHOP, date: '02/10/2026' }, session))).toBe('INVALID_BOOKING_TIME');
    data.barbershop[0].state = 'SUSPENDED';
    expect(await rejection(listBusyRanges({ barbershopId: SHOP, date: '2026-10-02' }, session))).toBe('Barbershop is not available for booking');
  });
});
