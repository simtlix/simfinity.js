import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simtlix/simfinity-js', () => {
  class SimfinityError extends Error {
    constructor(message, code) { super(message); this.code = code; }
  }
  return {
    default: {},
    SimfinityError,
    auth: { ForbiddenError: class ForbiddenError extends SimfinityError { constructor(message) { super(message, 'FORBIDDEN'); } } },
    getType: vi.fn(),
    getModel: vi.fn(),
    connect: vi.fn(),
    addNoEndpointType: vi.fn(),
  };
});

const simfinity = await import('@simtlix/simfinity-js');
const { applyReviewDefaults, refreshBarbershopReviewStats, assertReviewAllowed, reviewController } = await import('../types/review.controller.js');

describe('applyReviewDefaults', () => {
  it('sets createdAt when missing', () => {
    const doc = {};
    applyReviewDefaults(doc);
    expect(doc.createdAt).toBeDefined();
    expect(typeof doc.createdAt).toBe('string');
  });

  it('preserves existing createdAt', () => {
    const doc = { createdAt: '2025-01-01T00:00:00.000Z' };
    applyReviewDefaults(doc);
    expect(doc.createdAt).toBe('2025-01-01T00:00:00.000Z');
  });
});

describe('refreshBarbershopReviewStats', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates barbershop with computed avg and count', async () => {
    const updateOne = vi.fn().mockResolvedValue({});
    const ReviewModel = {
      aggregate: vi.fn().mockResolvedValue([{ _id: null, avg: 4.5, count: 10 }]),
    };
    const BarbershopModel = { updateOne };

    simfinity.getType.mockImplementation((name) => name);
    simfinity.getModel.mockImplementation((name) => {
      if (name === 'review') return ReviewModel;
      if (name === 'barbershop') return BarbershopModel;
      return null;
    });

    await refreshBarbershopReviewStats('shop-1');

    expect(ReviewModel.aggregate).toHaveBeenCalledWith([
      { $match: { barbershop: 'shop-1' } },
      { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);
    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'shop-1' },
      { $set: { averageRating: 4.5, reviewCount: 10 } },
    );
  });

  it('sets null averageRating and 0 reviewCount when no reviews', async () => {
    const updateOne = vi.fn().mockResolvedValue({});
    const ReviewModel = { aggregate: vi.fn().mockResolvedValue([]) };
    const BarbershopModel = { updateOne };

    simfinity.getType.mockImplementation((name) => name);
    simfinity.getModel.mockImplementation((name) => {
      if (name === 'review') return ReviewModel;
      if (name === 'barbershop') return BarbershopModel;
      return null;
    });

    await refreshBarbershopReviewStats('shop-2');

    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'shop-2' },
      { $set: { averageRating: null, reviewCount: 0 } },
    );
  });
});

describe('review eligibility (#59)', () => {
  // Shops, bookings and reviewed bookings read by the create check.
  const store = {
    barbershop: {
      shop: { _id: 'shop', owner: 'owner', state: 'APPROVED' },
      other: { _id: 'other', owner: 'owner-2', state: 'APPROVED' },
      draft: { _id: 'draft', owner: 'owner', state: 'DRAFT' },
    },
    booking: {
      done: { _id: 'done', client: 'client', barbershop: 'shop', state: 'COMPLETED' },
      confirmed: { _id: 'confirmed', client: 'client', barbershop: 'shop', state: 'CONFIRMED' },
      others: { _id: 'others', client: 'other-client', barbershop: 'shop', state: 'COMPLETED' },
      reviewed: { _id: 'reviewed', client: 'client', barbershop: 'shop', state: 'COMPLETED' },
      ownervisit: { _id: 'ownervisit', client: 'owner', barbershop: 'shop', state: 'COMPLETED' },
    },
    reviewedBookings: ['reviewed'],
  };
  const session = { id: 'review-transaction' };
  let sessions;
  beforeEach(() => {
    sessions = [];
    const read = (rows) => (id) => ({ select: () => ({ session: (used) => { sessions.push(used); return { lean: async () => rows[id] ?? null }; } }) });
    simfinity.getType.mockImplementation((name) => name);
    simfinity.getModel.mockImplementation((name) => ({
      findById: read(store[name] ?? {}),
      exists: (filter) => ({ session: async (used) => { sessions.push(used); return store.reviewedBookings.includes(String(filter.booking)) ? { _id: 'review' } : null; } }),
    }));
  });
  const client = { user: { id: 'client', roles: ['CLIENT'] } };
  const owner = { user: { id: 'owner', roles: ['OWNER'] } };
  const admin = { user: { id: 'admin', roles: ['PLATFORM_ADMIN'] } };
  const code = (doc, context) => assertReviewAllowed(doc, session, context).then(() => 'OK', (error) => error.code);

  it('accepts a completed booking the author made at the shop, reading in the review transaction', async () => {
    expect(await code({ barbershop: 'shop', booking: 'done' }, client)).toBe('OK');
    expect(sessions).toEqual([session, session, session]);
  });
  it('requires a booking from non-admins', async () => {
    expect(await code({ barbershop: 'shop' }, client)).toBe('REVIEW_BOOKING_REQUIRED');
  });
  it.each([['not completed', 'confirmed'], ['made by another client', 'others'], ['missing', 'gone']])('rejects a booking that is %s', async (_case, booking) => {
    expect(await code({ barbershop: 'shop', booking }, client)).toBe('INVALID_REVIEW_BOOKING');
  });
  it('rejects a booking made at another shop', async () => {
    expect(await code({ barbershop: 'other', booking: 'done' }, client)).toBe('INVALID_REVIEW_BOOKING');
  });
  it.each([['not approved', 'draft'], ['missing', 'gone']])('rejects a shop that is %s', async (_case, barbershop) => {
    expect(await code({ barbershop, booking: 'done' }, client)).toBe('INVALID_REVIEW_BARBERSHOP');
  });
  it("rejects the shop's owner reviewing their own shop", async () => {
    expect(await code({ barbershop: 'shop', booking: 'ownervisit' }, owner)).toBe('FORBIDDEN');
  });
  it('allows one review per booking, also for admins', async () => {
    expect(await code({ barbershop: 'shop', booking: 'reviewed' }, client)).toBe('REVIEW_ALREADY_EXISTS');
    expect(await code({ barbershop: 'shop', booking: 'reviewed' }, admin)).toBe('REVIEW_ALREADY_EXISTS');
  });
  it('lets an admin import a review without a booking', async () => {
    expect(await code({ barbershop: 'draft' }, admin)).toBe('OK');
  });
  it('checks the review before onSaving fills its defaults', async () => {
    const doc = { barbershop: 'shop' };
    await expect(reviewController.onSaving(doc, {}, session, client)).rejects.toMatchObject({ code: 'REVIEW_BOOKING_REQUIRED' });
    expect(doc.createdAt).toBeUndefined();
  });
  it("onSaved rewrites the shop statistics in the review's transaction, which serializes concurrent reviews of one booking", async () => {
    const aggregate = { session: vi.fn(), then: (resolve) => resolve([{ _id: null, avg: 4, count: 2 }]) };
    const updateOne = vi.fn().mockResolvedValue({});
    simfinity.getModel.mockImplementation((name) => ({ review: { aggregate: () => aggregate }, barbershop: { updateOne } })[name]);
    await reviewController.onSaved({ _id: 'review', barbershop: 'shop' }, {}, session);
    expect(aggregate.session).toHaveBeenCalledWith(session);
    expect(updateOne).toHaveBeenCalledWith({ _id: 'shop' }, { $set: { averageRating: 4, reviewCount: 2 } }, { session });
  });
});
