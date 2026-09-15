"use client";

import type { ReactNode } from "react";

type FormSectionProps = {
  title: string;
  icon?: string;
  children: ReactNode;
};

export default function FormSection({ title, icon, children }: FormSectionProps) {
  return (
    <section className="bg-surface-container-low rounded-2xl p-8 border-l-2 border-primary">
      <div className="flex items-center gap-3">
        {icon && (
          <span className="material-symbols-outlined text-primary text-xl">{icon}</span>
        )}
        <h3 className="text-xs uppercase tracking-widest text-primary font-semibold">
          {title}
        </h3>
      </div>
      <div className="mt-6 space-y-6">{children}</div>
    </section>
  );
}
