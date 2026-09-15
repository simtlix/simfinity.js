import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simtlix/simfinity-js', () => ({
  default: {},
  getType: vi.fn(),
  getModel: vi.fn(),
  connect: vi.fn(),
  addNoEndpointType: vi.fn(),
}));

const simfinity = await import('@simtlix/simfinity-js');
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
