"use client";

import Image from "next/image";
import { useRef } from "react";
import { cn } from "@/lib/cn";

type FormImageUploadProps = {
  label: string;
  value: string;
  onChange: (url: string) => void;
  variant?: "square" | "wide";
  hint?: string;
  disabled?: boolean;
};

export default function FormImageUpload({
  label,
  value,
  onChange,
  variant = "square",
  hint,
  disabled,
}: FormImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    onChange(url);
  };

  const sizeClass = variant === "square" ? "aspect-square w-48" : "aspect-[21/9] w-full";

  return (
    <div>
      <span className="text-[10px] uppercase tracking-[0.2em] text-primary mb-2 font-label font-semibold block">
        {label}
      </span>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={handleFile}
        disabled={disabled}
        className="sr-only"
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        className={cn(
          "relative border-2 border-dashed border-outline-variant/40 rounded-xl p-6 flex flex-col items-center justify-center transition-colors hover:border-primary/60 disabled:opacity-50 overflow-hidden",
          sizeClass,
        )}
      >
        {value ? (
          <Image
            src={value}
            alt={label}
            fill
            unoptimized
            sizes={variant === "square" ? "192px" : "100vw"}
            className="object-cover rounded-lg"
          />
        ) : (
          <>
            <span className="material-symbols-outlined text-3xl text-on-surface-variant/60 mb-2">
              cloud_upload
            </span>
            <span className="text-xs text-on-surface-variant/60">
              {hint ?? "Click to upload"}
            </span>
          </>
        )}
      </button>
    </div>
  );
}
