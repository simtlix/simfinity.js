'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { tv, type VariantProps } from 'tailwind-variants';

import { cn } from '@/lib/cn';

const button = tv({
  base: 'inline-flex items-center justify-center gap-2 font-bold transition-all disabled:opacity-50 disabled:pointer-events-none rounded-xl',
  variants: {
    variant: {
      gold: 'bg-gold-gradient text-on-primary-container shadow-lg hover:opacity-90 active:scale-95',
      outline:
        'border border-outline-variant/30 text-on-surface hover:bg-surface-container-high bg-transparent',
      ghost: 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high bg-transparent',
      link: 'text-primary underline-offset-4 hover:underline bg-transparent shadow-none px-0 py-0',
      danger: 'bg-error/20 text-error border border-error/30 hover:bg-error/30',
      destructive:
        'bg-error text-on-error border-0 shadow-none hover:opacity-90 active:scale-100',
    },
    size: {
      sm: 'px-4 py-2 text-[10px] uppercase tracking-[0.2em]',
      md: 'px-8 py-3 text-[11px] uppercase tracking-[0.2em]',
      lg: 'px-10 py-4 text-[11px] uppercase tracking-[0.2em]',
      /** Form footers — sentence case, semibold */
      form: 'px-8 py-3 text-sm font-semibold normal-case tracking-normal',
      /** Modals — compact gold / danger */
      modal: 'px-6 py-2 text-sm font-semibold normal-case tracking-normal shadow-lg',
      icon: 'p-2 aspect-square',
    },
  },
  defaultVariants: {
    variant: 'gold',
    size: 'lg',
  },
});

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof button> & {
    children: ReactNode;
  };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(button({ variant, size }), className)}
      {...props}
    />
  ),
);

Button.displayName = 'Button';

export { button as buttonVariants };
