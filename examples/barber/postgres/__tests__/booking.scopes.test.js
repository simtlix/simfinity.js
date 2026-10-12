import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simtlix/simfinity-postgres', () => ({
  default: {},
  getType: vi.fn(() => ({})),
  getModel: vi.fn(),
}));

import * as simfinity from '@simtlix/simfinity-postgres';
import { scopeBookingByRole } from '../types/booking.scopes.js';

describe('scopeBookingByRole', () => {
  beforeEach(() => {
    vi.mocked(simfinity.getModel).mockReset();
  });

  it('allows PLATFORM_ADMIN', async () => {
    const args = { x: 1 };
    await scopeBookingByRole({ args, context: { user: { roles: ['PLATFORM_ADMIN'] } } });
    expect(args).toEqual({ x: 1 });
  });

  it('scopes OWNER to an OR of owned shops and own client bookings without reading shops', async () => {
    const args = {};
    await scopeBookingByRole({
      args,
      context: { user: { id: 'owner1', roles: ['OWNER'] } },
    });
    expect(args.OR).toEqual([
      { conditions: [{ field: 'barbershop', path: 'owner.id', operator: 'EQ', value: 'owner1' }] },
      { conditions: [{ field: 'client', path: 'id', operator: 'EQ', value: 'owner1' }] },
    ]);
    expect(simfinity.getModel).not.toHaveBeenCalled();
  });

  it('scopes CLIENT to own client id', async () => {
    const args = {};
    await scopeBookingByRole({
      args,
      context: { user: { id: 'c1', roles: ['CLIENT'] } },
    });
    expect(args.client).toEqual({
      terms: [{ path: 'id', operator: 'EQ', value: 'c1' }],
    });
  });

  it('scopes anonymous to zero-match client id', async () => {
    const args = {};
    await scopeBookingByRole({ args, context: {} });
    expect(args.client.terms[0].value).toBe('00000000-0000-0000-0000-000000000000');
  });
});
