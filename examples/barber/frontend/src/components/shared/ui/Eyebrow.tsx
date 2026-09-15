'use client';

import { type HTMLAttributes } from 'react';

import { cn } from '@/lib/cn';
import { EYEBROW } from '@/theme/typography';

export type EyebrowProps = HTMLAttributes<HTMLSpanElement>;

/** Primary editorial kicker / section label (10px uppercase gold). */
export function Eyebrow({ className, ...props }: EyebrowProps) {
  return <span className={cn(EYEBROW, className)} {...props} />;
}
