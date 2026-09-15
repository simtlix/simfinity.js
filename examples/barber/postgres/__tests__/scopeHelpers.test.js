import { describe, it, expect } from 'vitest';
import {
  ZERO_MATCH_OBJECT_ID,
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
