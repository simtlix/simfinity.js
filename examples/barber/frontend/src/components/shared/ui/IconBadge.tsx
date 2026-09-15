'use client';

import { type HTMLAttributes } from 'react';
import { tv, type VariantProps } from 'tailwind-variants';

import { cn } from '@/lib/cn';

const iconBadge = tv({
  base: 'flex items-center justify-center shrink-0 text-primary',
  variants: {
    size: {
      sm: 'w-10 h-10 rounded-lg text-lg',
      md: 'w-12 h-12 rounded-lg text-xl',
      lg: 'w-14 h-14 rounded-full text-2xl',
    },
    variant: {
      contained: 'bg-surface-container-high border border-outline-variant/20',
      plain: 'bg-transparent',
    },
  },
  defaultVariants: {
    size: 'md',
    variant: 'contained',
  },
});

export type IconBadgeProps = HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof iconBadge> & {
    /** Material Symbols ligature name */
    icon: string;
  };

export function IconBadge({
  icon,
  className,
  size,
  variant,
  ...props
}: IconBadgeProps) {
  return (
    <div className={cn(iconBadge({ size, variant }), className)} {...props}>
      <span className="material-symbols-outlined">{icon}</span>
    </div>
  );
}

export { iconBadge as iconBadgeVariants };
