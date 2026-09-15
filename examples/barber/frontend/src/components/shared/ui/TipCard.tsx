'use client';

import { type ReactNode } from 'react';

import { cn } from '@/lib/cn';

import { Eyebrow } from './Eyebrow';
import { Surface } from './Surface';

export interface TipCardProps {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Editorial tip / quote panel with gold left accent. */
export function TipCard({ title, children, className }: TipCardProps) {
  return (
    <Surface tone="tip" padding="md" radius="xl" className={cn(className)}>
      <Eyebrow className="mb-2 block tracking-widest">{title}</Eyebrow>
      <p className="text-sm text-on-surface/80 leading-relaxed italic">{children}</p>
    </Surface>
  );
}
