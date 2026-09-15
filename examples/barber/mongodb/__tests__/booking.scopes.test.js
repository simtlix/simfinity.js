import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simtlix/simfinity-js', () => ({
  default: {},
  getType: vi.fn(() => ({})),
  getModel: vi.fn(),
}));

import * as simfinity from '@simtlix/simfinity-js';
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

  it('scopes OWNER to OR of shops and client', async () => {
    vi.mocked(simfinity.getModel).mockReturnValue({
      find: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([{ _id: 'shop1' }]),
      }),
    });
    const args = {};
    await scopeBookingByRole({
      args,
      context: { user: { id: 'owner1', roles: ['OWNER'] } },
    });
    expect(args.OR).toHaveLength(2);
    expect(args.OR[0].conditions[0].operator).toBe('IN');
    expect(args.OR[1].conditions[0].field).toBe('client');
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
    expect(args.client.terms[0].value).toBe('000000000000000000000000');
  });
});
