import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simtlix/simfinity-postgres', () => ({
  default: {},
  getType: vi.fn(),
  getModel: vi.fn(),
  connect: vi.fn(),
  addNoEndpointType: vi.fn(),
}));

const simfinity = await import('@simtlix/simfinity-postgres');
const { assertBundlePriceBelowServiceSum, recalculateBundleDuration, bundleController } = await import('../types/bundle.controller.js');

function mockServiceModel(services) {
  const model = {
    find: vi.fn().mockResolvedValue(services),
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

describe('large bundle duration', () => {
  it('includes services beyond the native 100-row default', async () => {
    const services = Array.from({ length: 101 }, (_, index) => ({ _id: `service-${index}`, durationMinutes: 1 }));
    simfinity.getType.mockReturnValue('service-type');
    simfinity.getModel.mockReturnValue({
      find: async (args) => {
        const { page = 1, size = 100 } = args.pagination || {};
        return services.slice((page - 1) * size, page * size);
      },
    });
    const doc = { services: services.map((service) => ({ service: service._id })) };
    await recalculateBundleDuration(doc);
    expect(doc.totalDurationMinutes).toBe(101);
  });
});

describe('bundle updates with cleared services', () => {
  it.each([['empty', { services: [] }], ['null', { $unset: { services: '' } }]])('resets duration for %s services without validating the old service set', async (_label, input) => {
    const stored = { price: 10, totalDurationMinutes: 30, services: [{ service: 'service' }] };
    simfinity.getType.mockImplementation((name) => name);
    simfinity.getModel.mockImplementation((name) => name === 'bundle'
      ? { findById: async () => stored }
      : { find: async () => [{ price: 20, durationMinutes: 30 }] });
    const changes = { ...structuredClone(input), price: 100 };
    await bundleController.onUpdating('bundle', changes, {});
    expect(changes).toEqual({ ...input, price: 100, totalDurationMinutes: 0 });
  });

  it('leaves duration untouched when services are omitted', async () => {
    simfinity.getType.mockImplementation((name) => name);
    simfinity.getModel.mockImplementation((name) => name === 'bundle'
      ? { findById: async () => ({ price: 10, totalDurationMinutes: 30, services: [{ service: 'service' }] }) }
      : { find: async () => [{ price: 20, durationMinutes: 30 }] });
    const changes = { name: 'Only name' };
    await bundleController.onUpdating('bundle', changes, {});
    expect(changes).toEqual({ name: 'Only name' });
  });
});
