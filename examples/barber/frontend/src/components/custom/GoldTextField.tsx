"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

const inputClass =
  "w-full border-0 border-b-2 border-outline-variant/20 bg-surface-container-low py-2 text-on-surface outline-none transition-colors " +
  "hover:border-outline-variant/40 focus:border-primary";

const labelClass =
  "mb-1 block font-label text-[0.625rem] font-normal uppercase tracking-[0.1rem] text-outline";

export type GoldTextFieldProps = Omit<
  React.ComponentPropsWithoutRef<"input">,
  "id" | "size"
> & {
  label: string;
  id?: string;
};

export const GoldTextField = React.forwardRef<HTMLInputElement, GoldTextFieldProps>(
  function GoldTextField({ label, id, className, ...rest }, ref) {
    const autoId = React.useId();
    const inputId = id ?? autoId;

    return (
      <div className="flex flex-col">
        <label htmlFor={inputId} className={labelClass}>
          {label}
        </label>
        <input
          ref={ref}
          id={inputId}
          className={cn(inputClass, className)}
          {...rest}
        />
      </div>
    );
  },
);
