'use client';

import { type ReactNode } from 'react';

import { cn } from '@/lib/cn';

import { Surface } from './Surface';

export interface InfoBannerProps {
  /** Material Symbols icon ligature name */
  icon: string;
  title: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Inline info callout with optional Material Symbol. */
export function InfoBanner({ icon, title, children, className }: InfoBannerProps) {
  return (
    <Surface
      tone="high"
      padding="sm"
      radius="xl"
      className={cn('border border-primary/10 bg-primary/5', className)}
    >
      <div className="flex gap-4">
        <span className="material-symbols-outlined text-primary shrink-0">{icon}</span>
        <div>
          <p className="text-sm font-semibold mb-1">{title}</p>
          <p className="text-xs text-on-surface-variant leading-relaxed">{children}</p>
        </div>
      </div>
    </Surface>
  );
}
