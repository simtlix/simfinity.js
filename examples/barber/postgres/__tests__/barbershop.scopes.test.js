import { describe, it, expect } from 'vitest';
import { scopeBarbershopByRole } from '../types/barbershop.scopes.js';

const ownerScope = (ownerId) => [
  { conditions: [{ field: 'state', operator: 'EQ', value: 'APPROVED' }] },
  { conditions: [{ field: 'owner.id', operator: 'EQ', value: ownerId }] },
];

describe('scopeBarbershopByRole', () => {
  it('allows PLATFORM_ADMIN', async () => {
    const args = {};
    await scopeBarbershopByRole({ args, context: { user: { roles: ['PLATFORM_ADMIN'] } } });
    expect(args).toEqual({});
  });

  it('limits OWNER to approved shops plus their own shops in any state', async () => {
    const args = {};
    await scopeBarbershopByRole({ args, context: { user: { id: 'owner-1', roles: ['OWNER'] } } });
    expect(args).toEqual({ OR: ownerScope('owner-1') });
  });

  it('keeps an OWNER state filter and ANDs the ownership rule with it', async () => {
    const args = { state: { operator: 'EQ', value: 'DRAFT' }, OR: [{ conditions: [{ field: 'name', value: 'x' }] }] };
    await scopeBarbershopByRole({ args, context: { user: { id: 'owner-2', roles: ['OWNER'] } } });
    expect(args.state).toEqual({ operator: 'EQ', value: 'DRAFT' });
    expect(args.OR).toEqual([{ conditions: [{ field: 'name', value: 'x' }] }]);
    expect(args.AND).toEqual([{ OR: ownerScope('owner-2') }]);
  });

  it('restricts CLIENT to APPROVED state', async () => {
    const args = {};
    await scopeBarbershopByRole({ args, context: { user: { roles: ['CLIENT'] } } });
    expect(args.state).toEqual({ operator: 'EQ', value: 'APPROVED' });
  });

  it('restricts anonymous to APPROVED state', async () => {
    const args = {};
    await scopeBarbershopByRole({ args, context: {} });
    expect(args.state).toEqual({ operator: 'EQ', value: 'APPROVED' });
  });
});
