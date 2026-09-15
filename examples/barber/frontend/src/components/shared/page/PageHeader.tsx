"use client";

import { Breadcrumb } from "./Breadcrumb";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  breadcrumbs?: { label: string; href?: string }[];
}

export function PageHeader({ title, subtitle, actions, breadcrumbs }: PageHeaderProps) {
  return (
    <div className="relative mb-8">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <div className="mb-4">
          <Breadcrumb items={breadcrumbs} />
        </div>
      )}

      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-headline italic text-4xl text-on-surface">{title}</h1>
          <div className="w-16 h-0.5 bg-primary mt-3" />
          {subtitle && (
            <p className="text-on-surface-variant text-sm mt-2">{subtitle}</p>
          )}
        </div>

        {actions && (
          <div className="flex items-center gap-3">{actions}</div>
        )}
      </div>
    </div>
  );
}
