import { describe, it, expect } from 'vitest';
import { scopeUserByRole } from '../types/user.scopes.js';
import { ZERO_MATCH_OBJECT_ID } from '../types/scopeHelpers.js';

describe('scopeUserByRole', () => {
  it('allows PLATFORM_ADMIN', async () => {
    const args = {};
    await scopeUserByRole({ args, context: { user: { roles: ['PLATFORM_ADMIN'] } } });
    expect(args).toEqual({});
  });

  it('denies anonymous', async () => {
    const args = {};
    await scopeUserByRole({ args, context: {} });
    expect(args.id.value).toBe(ZERO_MATCH_OBJECT_ID);
  });

  it('scopes to self id', async () => {
    const args = {};
    await scopeUserByRole({ args, context: { user: { id: 'u1', roles: ['CLIENT'] } } });
    expect(args.id).toEqual({
      operator: 'EQ', value: 'u1',
    });
  });
});
