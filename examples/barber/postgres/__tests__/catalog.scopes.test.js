import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simtlix/simfinity-postgres', () => ({
  default: {},
  getType: vi.fn((name) => name),
  getModel: vi.fn(),
}));

import * as simfinity from '@simtlix/simfinity-postgres';
import { serviceScopes } from '../types/service.scopes.js';
import { professionalScopes } from '../types/professional.scopes.js';
import { reviewScopes } from '../types/review.scopes.js';
import { bundleScopes } from '../types/bundle.scopes.js';
import { serviceCategoryScopes } from '../types/serviceCategory.scopes.js';

const scopes = { serviceScopes, professionalScopes, reviewScopes, bundleScopes, serviceCategoryScopes };
const approved = { terms: [{ path: 'state', operator: 'EQ', value: 'APPROVED' }] };

describe.each(Object.entries(scopes))('%s', (_name, scope) => {
  beforeEach(() => {
    // A scope that still loads barbershop IDs would call this model.
    vi.mocked(simfinity.getModel).mockReset().mockReturnValue({ find: vi.fn(() => { throw new Error('scope read barbershops'); }) });
  });

  it.each(['find', 'aggregate', 'get_by_id'])('%s restricts anonymous users and clients to approved shops through the relation', async (operation) => {
    for (const context of [{}, { user: { id: 'c1', roles: ['CLIENT'] } }]) {
      const args = {};
      await scope[operation]({ args, context, operation });
      expect(args).toEqual({ barbershop: approved });
    }
    expect(simfinity.getModel).not.toHaveBeenCalled();
  });

  it('restricts owners to their own shops through the relation', async () => {
    const args = {};
    await scope.find({ args, context: { user: { id: 'owner1', roles: ['OWNER'] } } });
    expect(args).toEqual({ barbershop: { terms: [{ path: 'owner.id', operator: 'EQ', value: 'owner1' }] } });
    expect(simfinity.getModel).not.toHaveBeenCalled();
  });

  it('leaves platform admins unrestricted', async () => {
    const args = { name: { operator: 'EQ', value: 'x' } };
    await scope.find({ args, context: { user: { id: 'a1', roles: ['PLATFORM_ADMIN'] } } });
    expect(args).toEqual({ name: { operator: 'EQ', value: 'x' } });
  });

  it('keeps a caller barbershop filter and intersects the restriction with it', async () => {
    const requested = Object.freeze({ terms: Object.freeze([{ path: 'id', operator: 'EQ', value: 'shop-x' }]) });
    const args = { barbershop: requested };
    await scope.find({ args, context: {} });
    expect(args.barbershop).toBe(requested);
    expect(args.AND).toEqual([{ conditions: [{ field: 'barbershop', path: 'state', operator: 'EQ', value: 'APPROVED' }] }]);
  });
});
