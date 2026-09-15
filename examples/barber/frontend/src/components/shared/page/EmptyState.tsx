"use client";

import { Button } from "@/components/shared/ui";

interface EmptyStateProps {
  icon?: string;
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ icon, title, message, actionLabel, onAction }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-20">
      {icon && (
        <div className="w-16 h-16 rounded-full bg-surface-container-high flex items-center justify-center">
          <span className="material-symbols-outlined text-on-surface-variant text-3xl">
            {icon}
          </span>
        </div>
      )}

      <h3 className="font-headline italic text-xl text-on-surface mt-6">{title}</h3>

      {message && (
        <p className="text-on-surface-variant text-sm mt-2 max-w-md text-center">{message}</p>
      )}

      {actionLabel && onAction && (
        <Button
          type="button"
          variant="gold"
          size="form"
          className="mt-6"
          onClick={onAction}
        >
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
