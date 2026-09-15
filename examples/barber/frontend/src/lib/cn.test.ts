import { describe, expect, it } from 'vitest';

import { cn } from './cn';

describe('cn', () => {
  it('merges conflicting Tailwind utilities with tailwind-merge', () => {
    expect(cn('px-4', 'px-2')).toBe('px-2');
    expect(cn('text-on-surface', 'text-primary')).toBe('text-primary');
  });

  it('handles conditional class lists', () => {
    expect(cn('base', false && 'hidden', true && 'block')).toBe('base block');
  });

  it('accepts object inputs via clsx', () => {
    expect(cn({ 'font-bold': true, italic: false })).toBe('font-bold');
  });
});
