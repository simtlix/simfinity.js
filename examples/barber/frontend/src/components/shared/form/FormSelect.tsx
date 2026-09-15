"use client";

type FormSelectProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  error?: string;
  placeholder?: string;
  disabled?: boolean;
};

export default function FormSelect({
  label,
  value,
  onChange,
  options,
  error,
  placeholder,
  disabled,
}: FormSelectProps) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-[0.2em] text-primary mb-2 font-label font-semibold block">
        {label}
      </span>
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="w-full bg-transparent border-b border-outline-variant/40 py-3 text-on-surface text-sm focus:border-primary focus:outline-none transition-colors appearance-none pr-8 disabled:opacity-50"
        >
          {placeholder && (
            <option value="" disabled className="bg-surface-container text-on-surface-variant">
              {placeholder}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} className="bg-surface-container text-on-surface">
              {opt.label}
            </option>
          ))}
        </select>
        <span className="material-symbols-outlined absolute right-0 top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">
          expand_more
        </span>
      </div>
      {error && <p className="text-error text-xs mt-1">{error}</p>}
    </label>
  );
}
