"use client";

type FormCurrencyInputProps = {
  label: string;
  value: number | string;
  onChange: (value: string) => void;
  error?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
};

export default function FormCurrencyInput({
  label,
  value,
  onChange,
  error,
  placeholder,
  disabled,
  required,
}: FormCurrencyInputProps) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-[0.2em] text-primary mb-2 font-label font-semibold block">
        {label}
        {required && <span className="text-error ml-0.5">*</span>}
      </span>
      <div className="relative">
        <span className="absolute left-0 top-1/2 -translate-y-1/2 text-on-surface-variant text-sm">
          $
        </span>
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          min={0}
          step="0.01"
          className="w-full bg-transparent border-b border-outline-variant/40 py-3 pl-4 text-on-surface text-sm focus:border-primary focus:outline-none transition-colors placeholder:text-on-surface-variant/40 disabled:opacity-50"
        />
      </div>
      {error && <p className="text-error text-xs mt-1">{error}</p>}
    </label>
  );
}
