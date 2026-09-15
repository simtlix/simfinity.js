"use client";

import { cn } from "@/lib/cn";

type FormToggleProps = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
};

export default function FormToggle({
  label,
  checked,
  onChange,
  disabled,
}: FormToggleProps) {
  return (
    <label className="flex items-center justify-between cursor-pointer">
      <span className="text-[10px] uppercase tracking-[0.2em] text-primary font-label font-semibold">
        {label}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative w-11 h-6 rounded-full transition-colors disabled:opacity-50",
          checked ? "bg-primary" : "bg-surface-container-high",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-on-primary transition-transform shadow-sm",
            checked ? "translate-x-5" : "translate-x-0",
          )}
        />
      </button>
    </label>
  );
}
