// A bundle's stored duration follows its services, so it matches what a booking of the bundle holds (FE-1/DER-2).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simtlix/simfinity-js', () => ({
  default: {},
  SimfinityError: class SimfinityError extends Error {},
  getType: vi.fn(),
  getModel: vi.fn(),
}));

const simfinity = await import('@simtlix/simfinity-js');
const { serviceController } = await import('../types/service.controller.js');

/** Mongoose-like query chain resolving to `result`. */
const chain = (result) => {
  const query = { select: () => query, session: () => query, lean: () => Promise.resolve(result) };
  return query;
};
/** The two filters the controller sends: `_id: { $in }` and `'services.service'`. */
const matches = (row, filter) => Object.entries(filter).every(([key, value]) => {
  if (key === 'services.service') return (row.services || []).some((item) => String(item?.service) === String(value));
  if (value?.$in) return value.$in.map(String).includes(String(row[key]));
  return String(row[key]) === String(value);
});

const session = { id: 'session' };
let data;
let writes;
beforeEach(() => {
  data = {
    service: [
      { _id: 'cut', durationMinutes: 30 },
      { _id: 'beard', durationMinutes: 20 },
    ],
    bundle: [
      { _id: 'combo', totalDurationMinutes: 50, services: [{ service: 'cut' }, { service: 'beard' }] },
      { _id: 'double', totalDurationMinutes: 60, services: [{ service: 'cut' }, { service: 'cut' }] },
      { _id: 'beard-only', totalDurationMinutes: 20, services: [{ service: 'beard' }] },
      { _id: 'custom', totalDurationMinutes: 45, services: [] },
    ],
  };
  writes = [];
  simfinity.getType.mockImplementation((name) => name);
  simfinity.getModel.mockImplementation((name) => ({
    find: (filter) => chain(data[name].filter((row) => matches(row, filter))),
    updateOne: vi.fn(async (filter, update, options) => {
      expect(options).toEqual({ session });
      writes.push([filter._id, update.$set.totalDurationMinutes]);
    }),
  }));
});

describe('serviceController', () => {
  it("stores the new total of every bundle that lists a service whose duration changes, each listing counted", async () => {
    await serviceController.onUpdating('cut', { durationMinutes: 45, $unset: { description: '' } }, session);
    expect(writes).toEqual([['combo', 65], ['double', 90]]);
  });

  it('counts a cleared duration as zero', async () => {
    await serviceController.onUpdating('beard', { $unset: { durationMinutes: '' } }, session);
    expect(writes).toEqual([['combo', 30], ['beard-only', 0]]);
  });

  it('leaves bundles alone when the duration is not written or their total does not change', async () => {
    await serviceController.onUpdating('cut', { name: 'Haircut' }, session);
    await serviceController.onUpdating('cut', { durationMinutes: 30 }, session);
    expect(writes).toEqual([]);
  });

  it('drops a deleted service from the totals, and keeps the stored total of a bundle left with none', async () => {
    await serviceController.onDelete({ _id: 'beard', durationMinutes: 20 }, session);
    expect(writes).toEqual([['combo', 30]]);
  });
});
