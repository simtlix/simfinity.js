"use client";

const DEFAULT_OPTIONS = [15, 30, 45, 60, 90, 120];

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

type FormDurationSelectProps = {
  label: string;
  value: number;
  onChange: (value: number) => void;
  options?: number[];
  disabled?: boolean;
};

export default function FormDurationSelect({
  label,
  value,
  onChange,
  options = DEFAULT_OPTIONS,
  disabled,
}: FormDurationSelectProps) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-[0.2em] text-primary mb-2 font-label font-semibold block">
        {label}
      </span>
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          disabled={disabled}
          className="w-full bg-transparent border-b border-outline-variant/40 py-3 text-on-surface text-sm focus:border-primary focus:outline-none transition-colors appearance-none pr-8 disabled:opacity-50"
        >
          {options.map((mins) => (
            <option key={mins} value={mins} className="bg-surface-container text-on-surface">
              {formatDuration(mins)}
            </option>
          ))}
        </select>
        <span className="material-symbols-outlined absolute right-0 top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">
          expand_more
        </span>
      </div>
    </label>
  );
}
