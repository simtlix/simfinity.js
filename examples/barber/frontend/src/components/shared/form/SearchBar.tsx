"use client";

import { type KeyboardEvent } from "react";
import { Button } from "@/components/shared/ui";
import { cn } from "@/lib/cn";

export interface SearchBarMode {
  id: string;
  label: string;
  icon?: string;
}

export interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onSearch: () => void;
  mode: string;
  onModeChange: (mode: string) => void;
  modes: SearchBarMode[];
  placeholder?: string;
  searchLabel?: string;
  className?: string;
}

export default function SearchBar({
  value,
  onChange,
  onSearch,
  mode,
  onModeChange,
  modes,
  placeholder = "¿Qué estás buscando hoy?",
  searchLabel = "BUSCAR",
  className = "",
}: SearchBarProps) {
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") onSearch();
  };

  return (
    <div
      className={cn(
        "bg-surface-container-low rounded-xl p-2 sm:p-3 border border-outline-variant/10 shadow-[0_40px_40px_-15px_rgba(0,0,0,0.4)]",
        className,
      )}
    >
      <div className="flex flex-col md:flex-row gap-3 md:gap-4">
        {/* Mode selector */}
        <div className="flex bg-surface-container-high p-1 rounded-lg shrink-0">
          {modes.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onModeChange(m.id)}
              className={cn(
                "flex items-center justify-center gap-1.5 px-5 py-2 rounded-md text-sm font-semibold transition-all",
                mode === m.id
                  ? "bg-primary text-on-primary"
                  : "text-on-surface/60 hover:text-on-surface",
              )}
            >
              {m.icon && (
                <span className="material-symbols-outlined text-base leading-none">
                  {m.icon}
                </span>
              )}
              {m.label}
            </button>
          ))}
        </div>

        {/* Text input */}
        <div className="flex-1 relative flex items-center min-w-0">
          <span className="material-symbols-outlined absolute left-4 text-outline pointer-events-none">
            search
          </span>
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="w-full bg-transparent border-none focus:ring-0 pl-12 pr-4 py-3 text-on-surface placeholder:text-outline/50"
          />
        </div>

        <Button type="button" variant="gold" size="form" onClick={onSearch} className="shrink-0 font-bold tracking-wide">
          {searchLabel}
        </Button>
      </div>
    </div>
  );
}
