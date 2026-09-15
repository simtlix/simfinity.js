"use client";

import type { ReactNode } from "react";

type FormSidePanelProps = {
  children: ReactNode;
};

export default function FormSidePanel({ children }: FormSidePanelProps) {
  return (
    <div className="bg-surface-container-low rounded-2xl p-6 space-y-6">
      {children}
    </div>
  );
}
