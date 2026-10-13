// Derived booking and bundle values: catalog prices and durations, server-owned fields and shop checks (#61, #130).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

class SimfinityError extends Error {
  constructor(message, code, status) {
    super(message);
    this.extensions = { code, status };
  }
}
class ForbiddenError extends Error {
  constructor(message) {
    super(message);
    this.extensions = { code: 'FORBIDDEN' };
  }
}

vi.mock('@simtlix/simfinity-postgres', () => ({
  default: {},
  SimfinityError,
  auth: { ForbiddenError },
  getType: vi.fn(),
  getModel: vi.fn(),
  registerMutation: vi.fn(),
}));
vi.mock('../database.js', () => ({ databaseSchema: 'barber' }));
vi.mock('../auth/permissions.js', () => ({ hasAnyRole: (context, roles) => roles.some((role) => context?.user?.roles?.includes(role)) }));

const simfinity = await import('@simtlix/simfinity-postgres');
const { bookingController } = await import('../types/booking.controller.js');
const { bundleController } = await import('../types/bundle.controller.js');
const { protect } = await import('../auth/ownership.js');

const SHOP = '6a1e1a6e-0000-4000-8000-000000000001';
const OTHER = '6a1e1a6e-0000-4000-8000-000000000002';
/** Evaluates the typed Simfinity filters the controllers send to native finds. */
const matches = (row, args) => Object.entries(args).every(([key, filter]) => {
  if (key === 'pagination') return true;
  if (filter.terms) return filter.terms.every((term) => String(row[key]) === String(term.value));
  if (filter.operator === 'IN') return filter.value.map(String).includes(String(row[key]));
  return String(row[key]) === String(filter.value);
});

let data;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
  data = {
    barbershop: [{ id: SHOP, owner: 'owner', state: 'APPROVED', timezone: 'UTC', bufferMinutes: 0, minAdvanceHours: 0, maxAdvanceDays: 30 }, { id: OTHER, owner: 'other-owner', state: 'APPROVED' }],
    professional: [{ id: 'p1', barbershop: SHOP }],
    service: [
      { id: 'cut', barbershop: SHOP, price: 25, durationMinutes: 30 },
      { id: 'beard', barbershop: SHOP, price: 15, durationMinutes: 20 },
      { id: 'retired', barbershop: SHOP, price: 30, durationMinutes: 40, isActive: false },
      { id: 'foreign', barbershop: OTHER, price: 100, durationMinutes: 90 },
    ],
    bundle: [
      { id: 'combo', barbershop: SHOP, price: 35, totalDurationMinutes: 50, services: [{ service: 'cut' }, { service: 'beard' }] },
      // Saved by an earlier version: the duration counted the repeated service once.
      { id: 'double', barbershop: SHOP, price: 45, totalDurationMinutes: 30, services: [{ service: 'cut' }, { service: 'cut' }] },
      { id: 'custom', barbershop: SHOP, price: 20, totalDurationMinutes: 45, services: [] },
      { id: 'withdrawn', barbershop: SHOP, price: 20, totalDurationMinutes: 30, isActive: false, services: [{ service: 'cut' }] },
      { id: 'foreign-combo', barbershop: OTHER, price: 90, totalDurationMinutes: 90, services: [{ service: 'foreign' }] },
      { id: 'legacy', barbershop: SHOP, price: 90, totalDurationMinutes: 120, services: [{ service: 'cut' }, { service: 'foreign' }] },
    ],
    booking: [
      { id: 'stored', barbershop: SHOP, client: 'client', professional: 'p1', scheduledDate: '2026-10-02', startTime: '10:00', endTime: '10:30', state: 'CONFIRMED', totalPrice: 25, confirmationCode: 'REAL01', createdAt: '2026-09-30T00:00:00.000Z', lines: [{ service: 'cut', price: 25, durationMinutes: 30 }] },
      // An owner discount, and a total an earlier version let the client zero.
      { id: 'discounted', barbershop: SHOP, client: 'client', professional: 'p1', scheduledDate: '2026-10-02', startTime: '12:00', endTime: '12:30', state: 'CONFIRMED', totalPrice: 0, lines: [{ service: 'cut', price: 10, durationMinutes: 30 }] },
      { id: 'kept', barbershop: SHOP, client: 'client', professional: 'p1', scheduledDate: '2026-10-05', startTime: '15:00', endTime: '15:40', state: 'CONFIRMED', totalPrice: 30, lines: [{ service: 'retired', price: 30, durationMinutes: 40 }] },
      { id: 'done', barbershop: SHOP, client: 'client', professional: 'p1', scheduledDate: '2026-09-30', startTime: '10:00', endTime: '10:30', state: 'COMPLETED', totalPrice: 25, lines: [{ service: 'cut', price: 25, durationMinutes: 30 }] },
      { id: 'cancelled', barbershop: SHOP, client: 'client', professional: 'p1', scheduledDate: '2026-10-03', startTime: '10:00', endTime: '10:30', state: 'CANCELLED_BY_CLIENT', totalPrice: 25, lines: [{ service: 'cut', price: 25, durationMinutes: 30 }] },
    ],
  };
  simfinity.getType.mockImplementation((name) => name);
  simfinity.getModel.mockImplementation((name) => ({
    findById: async (id, options) => { expect(options).toEqual({ session }); return data[name].find((row) => row.id === String(id)) ?? null; },
    find: async (args, options) => { expect(options).toEqual({ session }); return data[name].filter((row) => matches(row, args)); },
  }));
});
afterEach(() => vi.useRealTimers());

const session = { id: 'session', query: vi.fn(async () => ({ rows: [] })) };
const CLIENT = { user: { id: 'client', roles: ['CLIENT'] } };
const OWNER = { user: { id: 'owner', roles: ['OWNER'] } };
const OTHER_OWNER = { user: { id: 'other-owner', roles: ['OWNER'] } };
const ADMIN = { user: { id: 'admin', roles: ['PLATFORM_ADMIN'] } };
const create = (input, context = CLIENT) => {
  const doc = { barbershop: SHOP, professional: 'p1', scheduledDate: '2026-10-02', startTime: '14:00', state: 'CONFIRMED', lines: [{ service: 'cut', price: 25 }], ...input };
  return bookingController.onSaving(doc, { barbershop: { id: doc.barbershop } }, session, context).then(() => doc);
};
const update = (id, changes, context = CLIENT) => bookingController.onUpdating(id, changes, session, context).then(() => changes);
const code = (promise) => promise.then(() => null, (error) => error.extensions?.code ?? error.message);

describe('#61 booking derived fields', () => {
  it('derives line prices from the catalog for a client, or an owner of another shop, so totals cannot be zeroed', async () => {
    for (const context of [CLIENT, OTHER_OWNER]) {
      const doc = await create({ lines: [{ service: 'cut', price: 1 }, { service: 'beard', price: 0 }] }, context);
      expect(doc.lines.map((line) => line.price)).toEqual([25, 15]);
      expect(doc.totalPrice).toBe(40);
    }
  });

  it('rejects negative line prices', async () => {
    expect(await code(create({ lines: [{ service: 'cut', price: -500 }] }))).toBe('INVALID_BOOKING_LINE');
    expect(await code(create({ lines: [{ service: 'cut', price: -1 }] }, OWNER))).toBe('INVALID_BOOKING_LINE');
  });

  it("lets the shop's owner or an admin lower a catalog price, but not raise it", async () => {
    for (const context of [OWNER, ADMIN]) {
      const doc = await create({ lines: [{ service: 'cut', price: 20 }, { service: 'beard' }, { service: 'cut', price: 0 }] }, context);
      expect(doc.lines.map((line) => line.price)).toEqual([20, 15, 0]);
      expect(doc.totalPrice).toBe(35);
      expect(await code(create({ lines: [{ service: 'cut', price: 26 }] }, context))).toBe('INVALID_BOOKING_LINE');
    }
  });

  it('rejects a line whose service or bundle belongs to another barbershop, for every caller', async () => {
    for (const context of [CLIENT, OWNER, ADMIN]) {
      expect(await code(create({ lines: [{ service: 'foreign', price: 1 }] }, context))).toBe('INVALID_BOOKING_LINE');
      expect(await code(create({ lines: [{ bundle: 'foreign-combo' }] }, context))).toBe('INVALID_BOOKING_LINE');
    }
  });

  it("rejects inactive services and bundles for clients, but not for the shop's owner or an admin", async () => {
    expect(await code(create({ lines: [{ service: 'retired' }] }))).toBe('INVALID_BOOKING_LINE');
    expect(await code(create({ lines: [{ bundle: 'withdrawn' }] }))).toBe('INVALID_BOOKING_LINE');
    expect(await code(create({ lines: [{ service: 'retired' }] }, OTHER_OWNER))).toBe('INVALID_BOOKING_LINE');
    for (const context of [OWNER, ADMIN]) {
      const doc = await create({ lines: [{ service: 'retired' }, { bundle: 'withdrawn' }] }, context);
      expect(doc.totalPrice).toBe(50);
    }
  });

  it('stores totalPrice 0 for a booking without lines and ignores a sent totalPrice', async () => {
    const doc = await create({ lines: [], totalPrice: 999 });
    expect(doc.totalPrice).toBe(0);
  });

  it('generates confirmationCode and createdAt instead of storing sent values', async () => {
    const doc = await create({ confirmationCode: 'AAAAAA', createdAt: '1999-01-01T00:00:00.000Z' });
    expect(doc.confirmationCode).not.toBe('AAAAAA');
    expect(doc.createdAt).toBe('2026-10-01T12:00:00.000Z');
  });

  it('ignores totalPrice, confirmationCode and createdAt sent in an update', async () => {
    const changes = await update('stored', { id: 'stored', totalPrice: 0, confirmationCode: 'ZZZZZZ', createdAt: '1999-12-31', $unset: { createdAt: '' } });
    expect(changes).toEqual({ id: 'stored', totalPrice: 25 });
  });

  it('stores the total of the stored lines on every update, which corrects a total written by an earlier version', async () => {
    expect(await update('discounted', { id: 'discounted', notes: 'Running late' })).toEqual({ id: 'discounted', notes: 'Running late', totalPrice: 10 });
    expect(await update('discounted', { id: 'discounted', state: 'CANCELLED_BY_CLIENT' })).toMatchObject({ totalPrice: 10 });
  });

  it("keeps the price of a client's line whose service stays, and prices new lines from the catalog", async () => {
    const resent = await update('discounted', { id: 'discounted', lines: [{ service: 'cut', price: 25 }] });
    expect(resent.lines.map((line) => line.price)).toEqual([10]);
    expect(resent.totalPrice).toBe(10);
    const extended = await update('discounted', { id: 'discounted', lines: [{ service: 'beard', price: 0 }, { service: 'cut', price: 0 }, { service: 'cut', price: 0 }] });
    expect(extended.lines.map((line) => line.price)).toEqual([15, 10, 25]);
    expect(extended.totalPrice).toBe(50);
  });

  it('keeps a withdrawn service when a client resends the lines of a booking that has it, but adds no new one', async () => {
    const resent = await update('kept', { id: 'kept', lines: [{ service: 'retired' }] });
    expect(resent).toMatchObject({ totalPrice: 30, endTime: '15:40' });
    expect(await code(update('kept', { id: 'kept', lines: [{ service: 'retired' }, { service: 'retired' }] }))).toBe('INVALID_BOOKING_LINE');
  });

  it("lets the shop's owner keep a line's stored price above the catalog, but not raise it", async () => {
    data.booking.find((row) => row.id === 'stored').lines[0].price = 28;
    expect(await update('stored', { id: 'stored', lines: [{ service: 'cut', price: 28 }] }, OWNER)).toMatchObject({ totalPrice: 28 });
    expect(await code(update('stored', { id: 'stored', lines: [{ service: 'cut', price: 29 }] }, OWNER))).toBe('INVALID_BOOKING_LINE');
  });

  it("derives a bundle line's duration from the bundle's current services", async () => {
    const doc = await create({ lines: [{ bundle: 'double', durationMinutes: 1 }] });
    expect(doc.lines.map((line) => [line.durationMinutes, line.price])).toEqual([[60, 45]]);
    expect(doc.endTime).toBe('15:00');
    // A bundle without services keeps its own duration.
    expect((await create({ lines: [{ bundle: 'custom' }] })).endTime).toBe('14:45');
  });

  it("lets a booking's client change only its confirmed bookings", async () => {
    const guarded = protect('booking', bookingController);
    for (const id of ['done', 'cancelled']) {
      expect(await code(guarded.onUpdating(id, { id, notes: 'Late note' }, session, CLIENT))).toBe('FORBIDDEN');
    }
    await expect(guarded.onUpdating('done', { id: 'done', notes: 'Paid in cash' }, session, OWNER)).resolves.toBeUndefined();
    await expect(guarded.onUpdating('stored', { id: 'stored', notes: 'Running late' }, session, CLIENT)).resolves.toBeUndefined();
  });
});

describe('#130 bundle totals', () => {
  const save = (doc) => bundleController.onSaving({ barbershop: SHOP, ...doc }, {}, session);
  it('counts a repeated service every time in the price rule and the duration', async () => {
    const doc = { barbershop: SHOP, price: 35, services: [{ service: 'cut' }, { service: 'cut' }] };
    await bundleController.onSaving(doc, {}, session);
    expect(doc.totalDurationMinutes).toBe(60);
    expect(await code(save({ price: 50, services: [{ service: 'cut' }, { service: 'cut' }] }))).toBe('Bundle price must be less than the sum of service prices (MVP rule)');
  });

  it('rejects services of another barbershop and services that do not exist', async () => {
    expect(await code(save({ price: 50, services: [{ service: 'foreign' }] }))).toBe('INVALID_BUNDLE_SERVICE');
    expect(await code(save({ price: 10, services: [{ service: '00000000-0000-0000-0000-000000000001' }, { service: 'cut' }] }))).toBe('INVALID_BUNDLE_SERVICE');
  });

  it('keeps the derived duration of a bundle with services when an update sends another', async () => {
    const changes = { id: 'combo', totalDurationMinutes: 1, $unset: { description: '' } };
    await bundleController.onUpdating('combo', changes, session);
    expect(changes).toEqual({ id: 'combo', totalDurationMinutes: 50, $unset: { description: '' } });
    const cleared = { id: 'combo', $unset: { totalDurationMinutes: '' } };
    await bundleController.onUpdating('combo', cleared, session);
    expect(cleared).toEqual({ id: 'combo', totalDurationMinutes: 50 });
  });

  it("rejects new services of another shop and a move that keeps the old shop's services", async () => {
    expect(await code(bundleController.onUpdating('combo', { id: 'combo', services: [{ service: 'foreign' }] }, session))).toBe('INVALID_BUNDLE_SERVICE');
    expect(await code(bundleController.onUpdating('combo', { id: 'combo', barbershop: OTHER }, session))).toBe('INVALID_BUNDLE_SERVICE');
  });

  it('stores the current length of its services when another field of a bundle with services is saved', async () => {
    // An earlier version stored 30 for 'double', whose services last 60; the dashboard edit page no longer sends a duration.
    const changes = { id: 'double', name: 'Renamed' };
    await bundleController.onUpdating('double', changes, session);
    expect(changes).toEqual({ id: 'double', name: 'Renamed', totalDurationMinutes: 60 });
  });

  it('still saves other edits of a bundle saved before the rule', async () => {
    const changes = { id: 'legacy', name: 'Renamed' };
    await bundleController.onUpdating('legacy', changes, session);
    expect(changes).toEqual({ id: 'legacy', name: 'Renamed' });
  });
});
