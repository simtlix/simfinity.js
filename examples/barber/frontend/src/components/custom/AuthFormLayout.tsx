"use client";

import type { ReactNode } from "react";

import { Surface } from "@/components/shared/ui";

export interface AuthFormLayoutProps {
  title?: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function AuthFormLayout({
  title = "THE GROOMED",
  subtitle,
  children,
  footer,
}: AuthFormLayoutProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <Surface tone="low" padding="lg" radius="2xl" className="w-full max-w-[440px]">
        <div className="mb-6 text-center">
          <h1 className="font-headline text-3xl font-bold italic leading-tight text-primary">
            {title}
          </h1>
          <p className="mt-3 font-body text-[0.9375rem] text-on-surface-variant">{subtitle}</p>
        </div>

        {children}

        {footer && <div className="mt-4">{footer}</div>}
      </Surface>
    </div>
  );
}
