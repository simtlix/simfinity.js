import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simtlix/simfinity-js', () => ({
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

const simfinity = await import('@simtlix/simfinity-js');
const { hasAnyRole } = await import('../auth/permissions.js');

const {
  randomConfirmationCode,
  assignActingUserAsClientUnlessCanBookForOthers,
  resolveBarbershopIdFromBookingPayload,
  assertBarbershopApprovedForBooking,
  applyMissingBookingFieldDefaults,
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

  it('does not set doc.client for OWNER', () => {
    vi.mocked(hasAnyRole).mockReturnValue(true);
    const doc = { client: 'client-for-owner' };
    const context = { user: { id: 'owner-1', roles: ['OWNER'] } };
    assignActingUserAsClientUnlessCanBookForOthers(doc, context);
    expect(doc.client).toBe('client-for-owner');
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
  it('passes when barbershop is approved', async () => {
    const mockModel = { findById: vi.fn().mockReturnValue({ lean: () => Promise.resolve({ _id: '1', state: 'APPROVED' }) }) };
    simfinity.getType.mockReturnValue('barbershop-type');
    simfinity.getModel.mockReturnValue(mockModel);

    await expect(assertBarbershopApprovedForBooking('shop-1')).resolves.toBeUndefined();
  });

  it('throws when barbershop not found', async () => {
    const mockModel = { findById: vi.fn().mockReturnValue({ lean: () => Promise.resolve(null) }) };
    simfinity.getType.mockReturnValue('barbershop-type');
    simfinity.getModel.mockReturnValue(mockModel);

    await expect(assertBarbershopApprovedForBooking('bad-id')).rejects.toThrow('not available');
  });

  it('throws when barbershop is in DRAFT state', async () => {
    const mockModel = { findById: vi.fn().mockReturnValue({ lean: () => Promise.resolve({ _id: '1', state: 'DRAFT' }) }) };
    simfinity.getType.mockReturnValue('barbershop-type');
    simfinity.getModel.mockReturnValue(mockModel);

    await expect(assertBarbershopApprovedForBooking('draft-shop')).rejects.toThrow('not available');
  });
});

describe('applyMissingBookingFieldDefaults', () => {
  it('fills all missing defaults', () => {
    const doc = {};
    applyMissingBookingFieldDefaults(doc);
    expect(doc.confirmationCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(doc.paymentMethod).toBe('ON_SITE');
    expect(doc.state).toBe('CONFIRMED');
    expect(doc.createdAt).toBeDefined();
  });

  it('preserves existing values', () => {
    const doc = {
      confirmationCode: 'CUSTOM',
      paymentMethod: 'CARD',
      state: 'COMPLETED',
      createdAt: '2025-01-01',
    };
    applyMissingBookingFieldDefaults(doc);
    expect(doc.confirmationCode).toBe('CUSTOM');
    expect(doc.paymentMethod).toBe('CARD');
    expect(doc.state).toBe('COMPLETED');
    expect(doc.createdAt).toBe('2025-01-01');
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

  it('does nothing when lines is empty', () => {
    const doc = { startTime: '10:00', lines: [] };
    recalculatePriceAndEndTimeFromLines(doc);
    expect(doc.totalPrice).toBeUndefined();
  });

  it('does nothing when lines is undefined', () => {
    const doc = {};
    recalculatePriceAndEndTimeFromLines(doc);
    expect(doc.totalPrice).toBeUndefined();
  });

  it('computes totalPrice but skips endTime when startTime is missing', () => {
    const doc = { lines: [{ price: 100, durationMinutes: 30 }] };
    recalculatePriceAndEndTimeFromLines(doc);
    expect(doc.totalPrice).toBe(100);
    expect(doc.endTime).toBeUndefined();
  });
});
