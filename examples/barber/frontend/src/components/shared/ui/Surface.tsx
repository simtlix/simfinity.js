'use client';

import { forwardRef, type HTMLAttributes } from 'react';
import { tv, type VariantProps } from 'tailwind-variants';

import { cn } from '@/lib/cn';

const surface = tv({
  base: '',
  variants: {
    tone: {
      low: 'bg-surface-container-low border border-outline-variant/10',
      high: 'bg-surface-container-high border border-outline-variant/10',
      container: 'bg-surface-container border border-outline-variant/10',
      outlined: 'border border-outline-variant/20 bg-transparent',
      tip: 'bg-surface-container-high border-l-2 border-primary',
      summary:
        'bg-surface-container-low border-0 border-l-4 border-primary/30 shadow-2xl relative overflow-hidden',
    },
    padding: {
      none: '',
      sm: 'p-4',
      md: 'p-6',
      lg: 'p-8',
    },
    radius: {
      none: 'rounded-none',
      xl: 'rounded-xl',
      '2xl': 'rounded-2xl',
      '3xl': 'rounded-3xl',
    },
  },
  defaultVariants: {
    tone: 'low',
    padding: 'md',
    radius: 'xl',
  },
});

export type SurfaceProps = HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof surface>;

export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(
  ({ className, tone, padding, radius, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(surface({ tone, padding, radius }), className)}
      {...props}
    />
  ),
);

Surface.displayName = 'Surface';

export { surface as surfaceVariants };
