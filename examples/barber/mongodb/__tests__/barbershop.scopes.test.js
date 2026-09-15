import { describe, it, expect } from 'vitest';
import { scopeBarbershopByRole } from '../types/barbershop.scopes.js';

describe('scopeBarbershopByRole', () => {
  it('allows PLATFORM_ADMIN', async () => {
    const args = {};
    await scopeBarbershopByRole({ args, context: { user: { roles: ['PLATFORM_ADMIN'] } } });
    expect(args).toEqual({});
  });

  it('allows OWNER', async () => {
    const args = {};
    await scopeBarbershopByRole({ args, context: { user: { roles: ['OWNER'] } } });
    expect(args).toEqual({});
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
