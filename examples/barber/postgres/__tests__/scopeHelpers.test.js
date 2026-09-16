import { describe, it, expect } from 'vitest';
import {
  ZERO_MATCH_OBJECT_ID,
  intersectScopeFilter,
  isPlatformAdmin,
  isOwner,
  denyAnonymousByIdTerms,
  scopeRootIdToUser,
  scopeRelationToUser,
} from '../types/scopeHelpers.js';

describe('scopeHelpers', () => {
  describe('isPlatformAdmin', () => {
    it('returns true when PLATFORM_ADMIN in roles', () => {
      expect(isPlatformAdmin({ user: { roles: ['PLATFORM_ADMIN'] } })).toBe(true);
    });
    it('returns false otherwise', () => {
      expect(isPlatformAdmin({ user: { roles: ['OWNER'] } })).toBe(false);
      expect(isPlatformAdmin({})).toBe(false);
    });
  });

  describe('isOwner', () => {
    it('returns true when OWNER in roles', () => {
      expect(isOwner({ user: { roles: ['OWNER'] } })).toBe(true);
    });
    it('returns false otherwise', () => {
      expect(isOwner({ user: { roles: ['CLIENT'] } })).toBe(false);
    });
  });

  describe('denyAnonymousByIdTerms', () => {
    it('sets args.id to zero-match terms filter', () => {
      const args = {};
      denyAnonymousByIdTerms(args);
      expect(args.id).toEqual({
        operator: 'EQ', value: ZERO_MATCH_OBJECT_ID,
      });
    });
  });

  describe('scopeRootIdToUser', () => {
    it('scopes args.id to user id', () => {
      const args = {};
      scopeRootIdToUser(args, 'user123');
      expect(args.id).toEqual({
        operator: 'EQ', value: 'user123',
      });
    });
  });

  describe('scopeRelationToUser', () => {
    it('defaults field to user', () => {
      const args = {};
      scopeRelationToUser(args, 'uid');
      expect(args.user).toEqual({
        terms: [{ path: 'id', operator: 'EQ', value: 'uid' }],
      });
    });
    it('supports custom relation field', () => {
      const args = {};
      scopeRelationToUser(args, 'uid', 'client');
      expect(args.client).toEqual({
        terms: [{ path: 'id', operator: 'EQ', value: 'uid' }],
      });
    });
  });
});


describe('scope intersections', () => {
  it('retains a requested ID and ANDs the authenticated user restriction', () => {
    const requested = Object.freeze({ operator: 'EQ', value: 'someone-else' });
    const args = { id: requested };
    scopeRootIdToUser(args, 'current-user');
    expect(args.id).toBe(requested);
    expect(args.AND).toEqual([{ conditions: [{ field: 'id', operator: 'EQ', value: 'current-user' }] }]);
  });

  it('preserves relation terms and existing logical groups', () => {
    const terms = Object.freeze([{ path: 'email', operator: 'LIKE', value: 'requested' }]);
    const userGroup = { conditions: [{ field: 'title', value: 'Requested title' }] };
    const args = { user: { terms }, AND: [userGroup] };
    scopeRelationToUser(args, 'current-user');
    expect(args.user.terms).toBe(terms);
    expect(args.AND).toEqual([userGroup, { conditions: [{ field: 'user', path: 'id', operator: 'EQ', value: 'current-user' }] }]);
  });

  it('keeps a user OR separate from the owner scope OR', () => {
    const userOR = [{ conditions: [{ field: 'totalPrice', operator: 'GT', value: 100 }] }];
    const scopeOR = [{ conditions: [{ field: 'client', path: 'id', value: 'current-user' }] }];
    const args = { OR: userOR };
    intersectScopeFilter(args, 'OR', scopeOR);
    expect(args.OR).toBe(userOR);
    expect(args.AND).toEqual([{ OR: scopeOR }]);
  });
});
