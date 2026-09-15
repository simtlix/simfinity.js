"use client";

import Link from "next/link";

interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
}

export function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-2">
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        return (
          <span key={i} className="flex items-center gap-2">
            {i > 0 && (
              <span className="material-symbols-outlined text-primary/40 text-sm">
                chevron_right
              </span>
            )}
            {isLast || !item.href ? (
              <span className="text-xs uppercase tracking-widest text-on-surface-variant">
                {item.label}
              </span>
            ) : (
              <Link
                href={item.href}
                className="text-xs uppercase tracking-widest text-primary/60 hover:text-primary transition-colors"
              >
                {item.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
