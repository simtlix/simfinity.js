import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simtlix/simfinity-postgres', () => ({
  default: {},
  getType: vi.fn(),
  getModel: vi.fn(),
  connect: vi.fn(),
  addNoEndpointType: vi.fn(),
}));

const simfinity = await import('@simtlix/simfinity-postgres');
const { applyReviewDefaults, refreshBarbershopReviewStats } = await import('../types/review.controller.js');

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
    const update = vi.fn().mockResolvedValue({});
    const ReviewModel = {
      find: vi.fn().mockResolvedValue(Array.from({ length: 10 }, (_, id) => ({ id: String(id), rating: id % 2 ? 4 : 5 }))),
    };
    const BarbershopModel = { update };

    simfinity.getType.mockImplementation((name) => name);
    simfinity.getModel.mockImplementation((name) => {
      if (name === 'review') return ReviewModel;
      if (name === 'barbershop') return BarbershopModel;
      return null;
    });

    await refreshBarbershopReviewStats('shop-1');

    expect(update).toHaveBeenCalledWith(
      'shop-1',
      { averageRating: 4.5, reviewCount: 10 },
      { session: undefined },
    );
  });

  it('sets null averageRating and 0 reviewCount when no reviews', async () => {
    const update = vi.fn().mockResolvedValue({});
    const ReviewModel = { find: vi.fn().mockResolvedValue([]) };
    const BarbershopModel = { update };

    simfinity.getType.mockImplementation((name) => name);
    simfinity.getModel.mockImplementation((name) => {
      if (name === 'review') return ReviewModel;
      if (name === 'barbershop') return BarbershopModel;
      return null;
    });

    await refreshBarbershopReviewStats('shop-2');

    expect(update).toHaveBeenCalledWith(
      'shop-2',
      { averageRating: null, reviewCount: 0 },
      { session: undefined },
    );
  });
});
