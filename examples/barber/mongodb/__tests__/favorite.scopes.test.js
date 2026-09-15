import { describe, it, expect } from 'vitest';
import { scopeFavoriteByRole } from '../types/favorite.scopes.js';
import { ZERO_MATCH_OBJECT_ID } from '../types/scopeHelpers.js';

describe('scopeFavoriteByRole', () => {
  it('allows PLATFORM_ADMIN without mutating args', async () => {
    const args = { foo: 1 };
    await scopeFavoriteByRole({ args, context: { user: { roles: ['PLATFORM_ADMIN'] } } });
    expect(args).toEqual({ foo: 1 });
  });

  it('denies anonymous via zero-match id', async () => {
    const args = {};
    await scopeFavoriteByRole({ args, context: {} });
    expect(args.id.value).toBe(ZERO_MATCH_OBJECT_ID);
  });

  it('scopes to signed-in user relation', async () => {
    const args = {};
    await scopeFavoriteByRole({ args, context: { user: { id: 'abc', roles: ['CLIENT'] } } });
    expect(args.user).toEqual({
      terms: [{ path: 'id', operator: 'EQ', value: 'abc' }],
    });
  });
});
