import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simtlix/simfinity-postgres', () => {
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

vi.mock('../database.js', () => ({ databaseSchema: 'barber' }));

const simfinity = await import('@simtlix/simfinity-postgres');
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
  let update;
  let ReviewModel;
  beforeEach(() => {
    vi.clearAllMocks();
    update = vi.fn().mockResolvedValue({});
    // Paging the shop's reviews through the native model is what the aggregate replaces.
    ReviewModel = { find: vi.fn().mockRejectedValue(new Error('reviews must not be paged into Node')) };
    simfinity.getType.mockImplementation((name) => name);
    simfinity.getModel.mockImplementation((name) => ({ review: ReviewModel, barbershop: { update } })[name] ?? null);
  });
  const sessionReturning = (row) => ({ query: vi.fn().mockResolvedValue({ rows: [row] }) });

  it('updates the barbershop from one aggregate on the hook session', async () => {
    const session = sessionReturning({ count: 10, sum: 45 });
    await refreshBarbershopReviewStats('shop-1', session);
    expect(session.query).toHaveBeenCalledTimes(1);
    const [text, values] = session.query.mock.calls[0];
    expect(text).toMatch(/count\(\*\)/);
    expect(text).toMatch(/sum\(rating\)/);
    expect(text).toContain('FROM "barber"."review"');
    expect(text).toMatch(/WHERE barbershop = \$1::uuid/);
    expect(values).toEqual(['shop-1', null]);
    expect(ReviewModel.find).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('shop-1', { averageRating: 4.5, reviewCount: 10 }, { session });
  });

  it('leaves out the review being deleted', async () => {
    const session = sessionReturning({ count: 2, sum: 9 });
    await refreshBarbershopReviewStats('shop-1', session, 'review-9');
    expect(session.query.mock.calls[0][1]).toEqual(['shop-1', 'review-9']);
    expect(update).toHaveBeenCalledWith('shop-1', { averageRating: 4.5, reviewCount: 2 }, { session });
  });

  it('sets null averageRating and 0 reviewCount when no reviews', async () => {
    const session = sessionReturning({ count: 0, sum: null });
    await refreshBarbershopReviewStats('shop-2', session);
    expect(update).toHaveBeenCalledWith('shop-2', { averageRating: null, reviewCount: 0 }, { session });
  });

  it('rounds the average to one decimal as before', async () => {
    const session = sessionReturning({ count: 3, sum: 10 });
    await refreshBarbershopReviewStats('shop-3', session);
    expect(update).toHaveBeenCalledWith('shop-3', { averageRating: 3.3, reviewCount: 3 }, { session });
  });

  it('runs the hooks against the review barbershop, excluding a deleted review', async () => {
    const { reviewController } = await import('../types/review.controller.js');
    const session = sessionReturning({ count: 1, sum: 5 });
    await reviewController.onDelete({ id: 'r1', barbershop: 'shop-4' }, session);
    await reviewController.onSaved({ id: 'r2', barbershop: 'shop-4' }, {}, session);
    await reviewController.onUpdated({ id: 'r2', barbershop: 'shop-4' }, session);
    expect(session.query.mock.calls.map(([, values]) => values)).toEqual([['shop-4', 'r1'], ['shop-4', null], ['shop-4', null]]);
  });
});

describe('review eligibility (#59)', () => {
  // Shops, bookings and reviewed bookings read by the create check.
  const store = {
    barbershop: {
      shop: { id: 'shop', owner: 'owner', state: 'APPROVED' },
      other: { id: 'other', owner: 'owner-2', state: 'APPROVED' },
      draft: { id: 'draft', owner: 'owner', state: 'DRAFT' },
    },
    booking: {
      done: { id: 'done', client: 'client', barbershop: 'shop', state: 'COMPLETED' },
      confirmed: { id: 'confirmed', client: 'client', barbershop: 'shop', state: 'CONFIRMED' },
      others: { id: 'others', client: 'other-client', barbershop: 'shop', state: 'COMPLETED' },
      reviewed: { id: 'reviewed', client: 'client', barbershop: 'shop', state: 'COMPLETED' },
      ownervisit: { id: 'ownervisit', client: 'owner', barbershop: 'shop', state: 'COMPLETED' },
    },
    reviewedBookings: ['reviewed'],
  };
  let session;
  let sessions;
  beforeEach(() => {
    sessions = [];
    session = { query: vi.fn(async (_text, [booking]) => ({ rows: [{ reviewed: store.reviewedBookings.includes(booking) }] })) };
    simfinity.getType.mockImplementation((name) => name);
    simfinity.getModel.mockImplementation((name) => ({
      findById: async (id, options) => { sessions.push(options?.session); return store[name]?.[id] ?? null; },
    }));
  });
  const client = { user: { id: 'client', roles: ['CLIENT'] } };
  const owner = { user: { id: 'owner', roles: ['OWNER'] } };
  const admin = { user: { id: 'admin', roles: ['PLATFORM_ADMIN'] } };
  const code = (doc, context) => assertReviewAllowed(doc, session, context).then(() => 'OK', (error) => error.code);

  it('accepts a completed booking the author made at the shop, reading in the review transaction', async () => {
    expect(await code({ barbershop: 'shop', booking: 'done' }, client)).toBe('OK');
    expect(sessions).toEqual([session, session]);
    expect(session.query).toHaveBeenCalledTimes(1);
    const [text, values] = session.query.mock.calls[0];
    expect(text).toMatch(/SELECT EXISTS \(SELECT 1 FROM "barber"\."review" WHERE booking = \$1::uuid\)/);
    expect(values).toEqual(['done']);
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
    expect(session.query).not.toHaveBeenCalled();
  });
  it('checks the review before onSaving fills its defaults', async () => {
    const doc = { barbershop: 'shop' };
    await expect(reviewController.onSaving(doc, {}, session, client)).rejects.toMatchObject({ code: 'REVIEW_BOOKING_REQUIRED' });
    expect(doc.createdAt).toBeUndefined();
  });
  it("onSaved rewrites the shop statistics in the review's transaction, which serializes concurrent reviews of one booking", async () => {
    const update = vi.fn().mockResolvedValue({});
    simfinity.getModel.mockImplementation((name) => ({ barbershop: { update } })[name] ?? null);
    const stats = { query: vi.fn().mockResolvedValue({ rows: [{ count: 2, sum: 8 }] }) };
    await reviewController.onSaved({ id: 'review', barbershop: 'shop' }, {}, stats);
    expect(stats.query).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('shop', { averageRating: 4, reviewCount: 2 }, { session: stats });
  });
});
