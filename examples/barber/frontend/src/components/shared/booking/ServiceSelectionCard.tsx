"use client";

import { cn } from "@/lib/cn";

interface ServiceSelectionCardProps {
  name: string;
  description?: string;
  duration: number;
  price: number;
  category?: string;
  imageUrl?: string;
  selected: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

export function ServiceSelectionCard({
  name,
  description,
  duration,
  price,
  selected,
  onToggle,
  disabled,
}: ServiceSelectionCardProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "w-full text-left bg-surface-container-low rounded-xl p-6 border cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed",
        selected
          ? "border-primary bg-primary/5"
          : "border-outline-variant/10 hover:border-primary/30",
      )}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-on-surface truncate">{name}</p>
          {description && (
            <p className="text-sm text-on-surface-variant mt-1 line-clamp-2">
              {description}
            </p>
          )}
          <div className="flex items-center gap-4 mt-3">
            <span className="flex items-center gap-1 text-xs text-on-surface-variant">
              <span className="material-symbols-outlined text-sm">schedule</span>
              {duration} min
            </span>
            <span className="text-primary font-semibold">
              ${price.toLocaleString("es-AR", { minimumFractionDigits: 0 })}
            </span>
          </div>
        </div>

        <div
          className={cn(
            "w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors",
            selected ? "border-primary bg-primary" : "border-outline-variant",
          )}
        >
          {selected && (
            <span className="material-symbols-outlined text-on-primary text-base" style={{ fontVariationSettings: "'FILL' 1" }}>
              check
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
