"use client";

import { cn } from "@/lib/cn";

const defaultColorMap: Record<string, { text: string; bg: string }> = {
  ACTIVE:     { text: "text-emerald-400", bg: "bg-emerald-400/10" },
  APPROVED:   { text: "text-emerald-400", bg: "bg-emerald-400/10" },
  CONFIRMED:  { text: "text-emerald-400", bg: "bg-emerald-400/10" },
  COMPLETED:  { text: "text-emerald-400", bg: "bg-emerald-400/10" },
  INACTIVE:   { text: "text-error",       bg: "bg-error/10" },
  SUSPENDED:  { text: "text-error",       bg: "bg-error/10" },
  REJECTED:   { text: "text-red-400",     bg: "bg-red-400/10" },
  CANCELLED:  { text: "text-red-400",     bg: "bg-red-400/10" },
  PENDING:        { text: "text-amber-400", bg: "bg-amber-400/10" },
  DRAFT:          { text: "text-amber-400", bg: "bg-amber-400/10" },
  PENDING_REVIEW: { text: "text-amber-400", bg: "bg-amber-400/10" },
};

interface StatusChipProps {
  status: string;
  colorMap?: Record<string, { text: string; bg: string }>;
}

export function StatusChip({ status, colorMap }: StatusChipProps) {
  const merged = { ...defaultColorMap, ...colorMap };
  const colors = merged[status.toUpperCase()] ?? {
    text: "text-on-surface-variant",
    bg: "bg-surface-container-high",
  };

  return (
    <span
      className={cn(
        "inline-block rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wider",
        colors.text,
        colors.bg,
      )}
    >
      {status}
    </span>
  );
}
