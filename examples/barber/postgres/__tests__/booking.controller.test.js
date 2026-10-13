import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simtlix/simfinity-postgres', () => ({
  default: {},
  getType: vi.fn(),
  getModel: vi.fn(),
  connect: vi.fn(),
  addNoEndpointType: vi.fn(),
  registerMutation: vi.fn(),
  auth: { composeRules: vi.fn() },
}));

vi.mock('../auth/permissions.js', () => ({
  hasAnyRole: vi.fn(),
}));

vi.mock('../database.js', () => ({ databaseSchema: 'barber' }));

const simfinity = await import('@simtlix/simfinity-postgres');
const { hasAnyRole } = await import('../auth/permissions.js');

const {
  bookingController,
  randomConfirmationCode,
  assignActingUserAsClientUnlessCanBookForOthers,
  resolveBarbershopIdFromBookingPayload,
  assertBarbershopApprovedForBooking,
  applyServerOwnedBookingFields,
  recalculatePriceAndEndTimeFromLines,
} = await import('../types/booking.controller.js');

describe('randomConfirmationCode', () => {
  it('returns a 6-character string', () => {
    const code = randomConfirmationCode();
    expect(code).toHaveLength(6);
  });

  it('only contains valid characters (no ambiguous 0, O, 1, I)', () => {
    for (let i = 0; i < 50; i++) {
      const code = randomConfirmationCode();
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });
});

describe('assignActingUserAsClientUnlessCanBookForOthers', () => {
  beforeEach(() => {
    vi.mocked(hasAnyRole).mockReset();
  });

  it('sets doc.client to user id for regular users', () => {
    vi.mocked(hasAnyRole).mockReturnValue(false);
    const doc = {};
    const context = { user: { id: 'user-123' } };
    assignActingUserAsClientUnlessCanBookForOthers(doc, context);
    expect(doc.client).toBe('user-123');
  });

  it('does not set doc.client for PLATFORM_ADMIN', () => {
    vi.mocked(hasAnyRole).mockReturnValue(true);
    const doc = { client: 'other-user' };
    const context = { user: { id: 'admin-1', roles: ['PLATFORM_ADMIN'] } };
    assignActingUserAsClientUnlessCanBookForOthers(doc, context);
    expect(doc.client).toBe('other-user');
  });

  describe('by role and shop (#62)', () => {
    const as = (id, role) => ({ user: { id, roles: [role] } });
    beforeEach(() => {
      vi.mocked(hasAnyRole).mockImplementation((context, roles) => roles.some((role) => context?.user?.roles?.includes(role)));
    });

    it("books an OWNER at another owner's shop for themselves", () => {
      const doc = {};
      assignActingUserAsClientUnlessCanBookForOthers(doc, as('owner-1', 'OWNER'), { owner: 'owner-2' });
      expect(doc.client).toBe('owner-1');
    });

    it('books an OWNER who names another client at another shop for themselves', () => {
      const doc = { client: 'client-9' };
      assignActingUserAsClientUnlessCanBookForOthers(doc, as('owner-1', 'OWNER'), { owner: 'owner-2' });
      expect(doc.client).toBe('owner-1');
    });

    it("keeps a walk-in booking at the OWNER's own shop without a client", () => {
      const doc = {};
      assignActingUserAsClientUnlessCanBookForOthers(doc, as('owner-1', 'OWNER'), { owner: 'owner-1' });
      expect(doc.client).toBeUndefined();
    });

    it("keeps the client named by the shop's OWNER", () => {
      const doc = { client: 'client-9' };
      assignActingUserAsClientUnlessCanBookForOthers(doc, as('owner-1', 'OWNER'), { owner: 'owner-1' });
      expect(doc.client).toBe('client-9');
    });

    it('books a PLATFORM_ADMIN who names no client for themselves', () => {
      const doc = {};
      assignActingUserAsClientUnlessCanBookForOthers(doc, as('admin-1', 'PLATFORM_ADMIN'), { owner: 'owner-2' });
      expect(doc.client).toBe('admin-1');
    });

    it('keeps the client named by a PLATFORM_ADMIN', () => {
      const doc = { client: 'client-9' };
      assignActingUserAsClientUnlessCanBookForOthers(doc, as('admin-1', 'PLATFORM_ADMIN'), { owner: 'owner-2' });
      expect(doc.client).toBe('client-9');
    });
  });

  it('does nothing when context has no user', () => {
    const doc = {};
    assignActingUserAsClientUnlessCanBookForOthers(doc, {});
    expect(doc.client).toBeUndefined();
  });
});

describe('resolveBarbershopIdFromBookingPayload', () => {
  it('returns raw string id from args', () => {
    const result = resolveBarbershopIdFromBookingPayload({ barbershop: 'shop-1' }, {});
    expect(result).toBe('shop-1');
  });

  it('extracts id from object in args', () => {
    const result = resolveBarbershopIdFromBookingPayload({ barbershop: { id: 'shop-2' } }, {});
    expect(result).toBe('shop-2');
  });

  it('extracts _id from object in args', () => {
    const result = resolveBarbershopIdFromBookingPayload({ barbershop: { _id: 'shop-3' } }, {});
    expect(result).toBe('shop-3');
  });

  it('falls back to doc.barbershop when args is empty', () => {
    const result = resolveBarbershopIdFromBookingPayload({}, { barbershop: 'from-doc' });
    expect(result).toBe('from-doc');
  });

  it('returns null when both are null', () => {
    const result = resolveBarbershopIdFromBookingPayload({}, {});
    expect(result).toBeUndefined();
  });
});

describe('assertBarbershopApprovedForBooking', () => {
  it('returns the barbershop when it is approved', async () => {
    const mockModel = { findById: vi.fn().mockResolvedValue({ _id: '1', state: 'APPROVED' }) };
    simfinity.getType.mockReturnValue('barbershop-type');
    simfinity.getModel.mockReturnValue(mockModel);

    await expect(assertBarbershopApprovedForBooking('shop-1')).resolves.toMatchObject({ _id: '1', state: 'APPROVED' });
  });

  it('throws when barbershop not found', async () => {
    const mockModel = { findById: vi.fn().mockResolvedValue(null) };
    simfinity.getType.mockReturnValue('barbershop-type');
    simfinity.getModel.mockReturnValue(mockModel);

    await expect(assertBarbershopApprovedForBooking('bad-id')).rejects.toThrow('not available');
  });

  it('throws when barbershop is in DRAFT state', async () => {
    const mockModel = { findById: vi.fn().mockResolvedValue({ _id: '1', state: 'DRAFT' }) };
    simfinity.getType.mockReturnValue('barbershop-type');
    simfinity.getModel.mockReturnValue(mockModel);

    await expect(assertBarbershopApprovedForBooking('draft-shop')).rejects.toThrow('not available');
  });
});

describe('applyServerOwnedBookingFields', () => {
  it('fills all missing defaults', () => {
    const doc = {};
    applyServerOwnedBookingFields(doc);
    expect(doc.confirmationCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(doc.paymentMethod).toBe('ON_SITE');
    expect(doc.state).toBe('CONFIRMED');
    expect(doc.createdAt).toBeDefined();
  });

  it('replaces a sent confirmation code and creation time but keeps payment method and state', () => {
    const doc = {
      confirmationCode: 'CUSTOM',
      paymentMethod: 'CARD',
      state: 'COMPLETED',
      createdAt: '2025-01-01',
    };
    applyServerOwnedBookingFields(doc, new Date('2026-10-01T12:00:00.000Z'));
    expect(doc.confirmationCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(doc.paymentMethod).toBe('CARD');
    expect(doc.state).toBe('COMPLETED');
    expect(doc.createdAt).toBe('2026-10-01T12:00:00.000Z');
  });
});

describe('recalculatePriceAndEndTimeFromLines', () => {
  it('computes totalPrice from lines', () => {
    const doc = {
      startTime: '09:00',
      lines: [
        { price: 100, durationMinutes: 30 },
        { price: 200, durationMinutes: 45 },
      ],
    };
    recalculatePriceAndEndTimeFromLines(doc);
    expect(doc.totalPrice).toBe(300);
    expect(doc.endTime).toBe('10:15');
  });

  it('handles missing price gracefully', () => {
    const doc = {
      startTime: '14:00',
      lines: [{ durationMinutes: 60 }, { price: 50, durationMinutes: 30 }],
    };
    recalculatePriceAndEndTimeFromLines(doc);
    expect(doc.totalPrice).toBe(50);
    expect(doc.endTime).toBe('15:30');
  });

  it('stores totalPrice 0 without lines, replacing a sent total, and still derives endTime', () => {
    const doc = { startTime: '10:00', lines: [], totalPrice: 999 };
    recalculatePriceAndEndTimeFromLines(doc);
    expect(doc.totalPrice).toBe(0);
    expect(doc.endTime).toBe('10:00');
  });

  it('derives no endTime when lines and startTime are undefined', () => {
    const doc = {};
    recalculatePriceAndEndTimeFromLines(doc);
    expect(doc.totalPrice).toBe(0);
    expect(doc.endTime).toBeNull();
  });

  it('counts a negative price stored by an earlier version as zero', () => {
    const doc = { startTime: '10:00', lines: [{ price: -500, durationMinutes: 30 }, { price: 25, durationMinutes: 30 }] };
    recalculatePriceAndEndTimeFromLines(doc);
    expect(doc.totalPrice).toBe(25);
  });

  it('computes totalPrice and clears endTime when startTime is missing', () => {
    const doc = { endTime: '18:00', lines: [{ price: 100, durationMinutes: 30 }] };
    recalculatePriceAndEndTimeFromLines(doc);
    expect(doc.totalPrice).toBe(100);
    expect(doc.endTime).toBeNull();
  });

  it('replaces an endTime sent by the client, with or without lines', () => {
    const empty = { startTime: '14:30', endTime: '17:30' };
    recalculatePriceAndEndTimeFromLines(empty);
    expect(empty.endTime).toBe('14:30');
    const lined = { startTime: '10:00', endTime: '10:00', lines: [{ price: 25, durationMinutes: 30 }] };
    recalculatePriceAndEndTimeFromLines(lined);
    expect(lined.endTime).toBe('10:30');
  });

  it('stores a booking that ends at midnight as 24:00', () => {
    const doc = { startTime: '23:30', lines: [{ price: 25, durationMinutes: 30 }] };
    recalculatePriceAndEndTimeFromLines(doc);
    expect(doc.endTime).toBe('24:00');
  });
});

describe('booking updates with cleared lines', () => {
  it.each([['empty', { lines: [] }], ['null', { $unset: { lines: '' } }]])('resets derived values for %s lines and keeps the clearing input', async (_label, input) => {
    const stored = { startTime: '10:00', endTime: '10:30', totalPrice: 20, lines: [{ price: 20, durationMinutes: 30 }] };
    simfinity.getModel.mockReturnValue({ findById: async () => stored });
    const changes = structuredClone(input);
    await bookingController.onUpdating('booking', changes, {});
    expect(changes).toEqual({ ...input, totalPrice: 0, endTime: '10:00' });
  });

  it('keeps endTime and stores the total of the stored lines when lines and startTime are omitted', async () => {
    simfinity.getModel.mockReturnValue({ findById: async () => ({ startTime: '10:00', endTime: '10:30', totalPrice: 20, lines: [{ price: 20, durationMinutes: 30 }] }) });
    const changes = { notes: 'Only notes' };
    await bookingController.onUpdating('booking', changes, {});
    expect(changes).toEqual({ notes: 'Only notes', totalPrice: 20 });
  });
});
