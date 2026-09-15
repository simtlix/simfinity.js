import { it, expect, vi } from 'vitest';
vi.mock('@simtlix/simfinity-postgres', () => ({
  auth: { ForbiddenError: class extends Error {} },
  getType: (name) => name,
  getModel: (name) => ({ findById: async (id) => name === 'user' ? { id, role: 'CLIENT' } : { id: 'service', barbershop: 'shop', owner: 'other' } }),
}));
const { protect } = await import('../auth/ownership.js');
const client = { user: { id: 'client', roles: ['CLIENT'] } };
it('rejects self privilege escalation', async () => {
  await expect(protect('user').onUpdating('client', { role: 'PLATFORM_ADMIN' }, {}, client)).rejects.toThrow();
});
it('rejects another user update', async () => {
  await expect(protect('user').onUpdating('other', { name: 'attack' }, {}, client)).rejects.toThrow();
});
it('rejects another owner service update', async () => {
  await expect(protect('service').onUpdating('service', { name: 'attack' }, {}, { user: { id: 'owner', roles: ['OWNER'] } })).rejects.toThrow();
});
