import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simtlix/simfinity-js', () => ({
  default: {},
  getType: vi.fn(),
  getModel: vi.fn(),
  connect: vi.fn(),
  addNoEndpointType: vi.fn(),
}));

const simfinity = await import('@simtlix/simfinity-js');
const { assertBundlePriceBelowServiceSum, recalculateBundleDuration } = await import('../types/bundle.controller.js');

function mockServiceModel(services) {
  const model = {
    find: vi.fn().mockReturnValue({
      lean: () => Promise.resolve(services),
    }),
  };
  simfinity.getType.mockReturnValue('service-type');
  simfinity.getModel.mockReturnValue(model);
  return model;
}

describe('assertBundlePriceBelowServiceSum', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does nothing when services list is empty', async () => {
    const doc = { services: [] };
    await assertBundlePriceBelowServiceSum(doc);
  });

  it('does nothing when services is undefined', async () => {
    const doc = {};
    await assertBundlePriceBelowServiceSum(doc);
  });

  it('passes when bundle price is below service sum', async () => {
    mockServiceModel([
      { _id: 's1', price: 100 },
      { _id: 's2', price: 200 },
    ]);
    const doc = { price: 250, services: [{ service: 's1' }, { service: 's2' }] };
    await expect(assertBundlePriceBelowServiceSum(doc)).resolves.toBeUndefined();
  });

  it('throws when bundle price equals service sum', async () => {
    mockServiceModel([
      { _id: 's1', price: 100 },
      { _id: 's2', price: 200 },
    ]);
    const doc = { price: 300, services: [{ service: 's1' }, { service: 's2' }] };
    await expect(assertBundlePriceBelowServiceSum(doc)).rejects.toThrow('must be less');
  });

  it('throws when bundle price exceeds service sum', async () => {
    mockServiceModel([{ _id: 's1', price: 50 }]);
    const doc = { price: 100, services: [{ service: 's1' }] };
    await expect(assertBundlePriceBelowServiceSum(doc)).rejects.toThrow('must be less');
  });

  it('passes when doc.price is null', async () => {
    mockServiceModel([{ _id: 's1', price: 100 }]);
    const doc = { price: null, services: [{ service: 's1' }] };
    await expect(assertBundlePriceBelowServiceSum(doc)).resolves.toBeUndefined();
  });
});

describe('recalculateBundleDuration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sums duration from constituent services', async () => {
    mockServiceModel([
      { _id: 's1', durationMinutes: 30 },
      { _id: 's2', durationMinutes: 45 },
    ]);
    const doc = { services: [{ service: 's1' }, { service: 's2' }] };
    await recalculateBundleDuration(doc);
    expect(doc.totalDurationMinutes).toBe(75);
  });

  it('does nothing when services is empty', async () => {
    const doc = { services: [] };
    await recalculateBundleDuration(doc);
    expect(doc.totalDurationMinutes).toBeUndefined();
  });
});
