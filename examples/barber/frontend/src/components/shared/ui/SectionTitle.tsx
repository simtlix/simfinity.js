'use client';

import { type HTMLAttributes, type ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { BODY_LEAD, HERO_ITALIC } from '@/theme/typography';

import { Eyebrow } from './Eyebrow';

export interface SectionTitleProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Main heading text */
  heading: ReactNode;
  /** Optional kicker above the title */
  eyebrow?: ReactNode;
  /** Optional lead paragraph under the title */
  subtitle?: ReactNode;
  /** Heading level */
  as?: 'h1' | 'h2' | 'h3';
}

export function SectionTitle({
  heading,
  eyebrow,
  subtitle,
  as: Tag = 'h1',
  className,
  ...rest
}: SectionTitleProps) {
  return (
    <header className={cn(className)} {...rest}>
      {eyebrow != null && eyebrow !== false && (
        <Eyebrow className="mb-4 block">{eyebrow}</Eyebrow>
      )}
      <Tag className={HERO_ITALIC}>{heading}</Tag>
      {subtitle != null && subtitle !== false && (
        <p className={BODY_LEAD}>{subtitle}</p>
      )}
    </header>
  );
}
