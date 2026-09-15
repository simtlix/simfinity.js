"use client";

type FormFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  type?: string;
};

export default function FormField({
  label,
  value,
  onChange,
  error,
  placeholder,
  disabled,
  required,
  type = "text",
}: FormFieldProps) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-[0.2em] text-primary mb-2 font-label font-semibold block">
        {label}
        {required && <span className="text-error ml-0.5">*</span>}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full bg-transparent border-b border-outline-variant/40 py-3 text-on-surface text-sm focus:border-primary focus:outline-none transition-colors placeholder:text-on-surface-variant/40 disabled:opacity-50"
      />
      {error && <p className="text-error text-xs mt-1">{error}</p>}
    </label>
  );
}
