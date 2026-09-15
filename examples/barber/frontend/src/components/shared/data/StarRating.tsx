"use client";

import { cn } from "@/lib/cn";

interface StarRatingProps {
  rating: number;
  count?: number;
  size?: "sm" | "md";
}

export function StarRating({ rating, count, size = "md" }: StarRatingProps) {
  const iconSize = size === "sm" ? "text-base" : "text-xl";
  const stars: React.ReactNode[] = [];

  for (let i = 1; i <= 5; i++) {
    if (rating >= i) {
      stars.push(
        <span key={i} className={cn("material-symbols-outlined text-primary", iconSize)} style={{ fontVariationSettings: "'FILL' 1" }}>
          star
        </span>,
      );
    } else if (rating >= i - 0.5) {
      stars.push(
        <span key={i} className={cn("material-symbols-outlined text-primary", iconSize)} style={{ fontVariationSettings: "'FILL' 1" }}>
          star_half
        </span>,
      );
    } else {
      stars.push(
        <span key={i} className={cn("material-symbols-outlined text-on-surface-variant/30", iconSize)}>
          star
        </span>,
      );
    }
  }

  return (
    <span className="inline-flex items-center">
      {stars}
      {count !== undefined && (
        <span className="text-on-surface-variant text-xs ml-1">({count})</span>
      )}
    </span>
  );
}
