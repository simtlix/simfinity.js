import { describe, it, expect } from 'vitest';
import { stripOwnerFromUpdatePayload } from '../types/barbershop.controller.js';

describe('stripOwnerFromUpdatePayload', () => {
  it('removes owner from doc', () => {
    const doc = { owner: 'user-1', name: 'My Shop' };
    stripOwnerFromUpdatePayload(doc);
    expect(doc.owner).toBeUndefined();
    expect(doc.name).toBe('My Shop');
  });

  it('does nothing when owner is not present', () => {
    const doc = { name: 'Shop' };
    stripOwnerFromUpdatePayload(doc);
    expect(doc).toEqual({ name: 'Shop' });
  });
});
