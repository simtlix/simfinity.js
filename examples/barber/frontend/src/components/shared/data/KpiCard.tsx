"use client";

import { cn } from "@/lib/cn";
import { IconBadge, Surface } from "@/components/shared/ui";

interface KpiCardProps {
  label: string;
  value: string | number;
  trend?: { value: string; positive: boolean };
  icon?: string;
}

export function KpiCard({ label, value, trend, icon }: KpiCardProps) {
  return (
    <Surface
      tone="low"
      padding="md"
      radius="2xl"
      className="hover:border-primary/30 transition-colors"
    >
      {icon && <IconBadge icon={icon} size="md" variant="contained" />}

      <p className="text-xs uppercase tracking-widest text-on-surface-variant mt-4">{label}</p>

      <div className="flex items-end gap-3 mt-1">
        <span className="font-headline text-3xl text-on-surface">{value}</span>

        {trend && (
          <span
            className={cn(
              "text-xs px-2 py-1 rounded-full",
              trend.positive ? "text-emerald-400 bg-emerald-400/10" : "text-error bg-error/10",
            )}
          >
            {trend.value}
          </span>
        )}
      </div>
    </Surface>
  );
}
