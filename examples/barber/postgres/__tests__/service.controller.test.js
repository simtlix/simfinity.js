// A bundle's stored duration follows its services, so it matches what a booking of the bundle holds (FE-1/DER-2).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simtlix/simfinity-postgres', () => ({
  default: {},
  SimfinityError: class SimfinityError extends Error {},
  getType: vi.fn(),
  getModel: vi.fn(),
}));

const simfinity = await import('@simtlix/simfinity-postgres');
const { serviceController } = await import('../types/service.controller.js');

/** The two typed filters the controller sends: `id IN` and a `services` term on `service.id`. */
const matches = (row, args) => Object.entries(args).every(([key, filter]) => {
  if (key === 'pagination') return true;
  if (key === 'services') {
    return filter.terms.every((term) => term.path === 'service.id' && (row.services || []).some((item) => String(item?.service) === String(term.value)));
  }
  if (filter.operator === 'IN') return filter.value.map(String).includes(String(row[key]));
  return String(row[key]) === String(filter.value);
});

const session = { id: 'session' };
let data;
let writes;
beforeEach(() => {
  data = {
    service: [
      { id: 'cut', durationMinutes: 30 },
      { id: 'beard', durationMinutes: 20 },
    ],
    bundle: [
      { id: 'combo', totalDurationMinutes: 50, services: [{ service: 'cut' }, { service: 'beard' }] },
      { id: 'double', totalDurationMinutes: 60, services: [{ service: 'cut' }, { service: 'cut' }] },
      { id: 'beard-only', totalDurationMinutes: 20, services: [{ service: 'beard' }] },
      { id: 'custom', totalDurationMinutes: 45, services: [] },
    ],
  };
  writes = [];
  simfinity.getType.mockImplementation((name) => name);
  simfinity.getModel.mockImplementation((name) => ({
    find: async (args, options) => { expect(options).toEqual({ session }); return data[name].filter((row) => matches(row, args)); },
    update: vi.fn(async (id, changes, options) => {
      expect(options).toEqual({ session });
      writes.push([id, changes.totalDurationMinutes]);
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
    await serviceController.onDelete({ id: 'beard', durationMinutes: 20 }, session);
    expect(writes).toEqual([['combo', 30]]);
  });
});
